import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Agent, fetch } from 'undici';
import type { RunService, StartedRun } from '../src/app/run-service';
import { disableImplicitTracing, loadEnvironment, TRACING_OPT_IN } from '../src/config/env';
import { DEFAULT_MCP_COMMAND, RuntimeConfig } from '../src/config/runtime-config';
import type { AgentNode, Graph, Run } from '../src/domain/types';
import type { McpPolicy } from '../src/mcp/policy';
import { RunManager } from '../src/mcp/run-manager';
import { ModelFactory } from '../src/providers/model-factory';
import { RunEventSink } from '../src/runtime/run-events';
import { RunStore } from '../src/runtime/run-store';
import { connectMcpClient, privateHome } from '../src/tools/mcp/mcp-client';
import { createNodeToolkit } from '../src/tools/node-toolkit';
import { guardedLookup, isBlockedAddress, type Resolver } from '../src/tools/public-address';
import { Workspace } from '../src/tools/workspace';

const POSIX = process.platform !== 'win32';
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-security-test-'));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withEnv<T>(names: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(Object.keys(names).map((name) => [name, process.env[name]]));
  const restore = () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  for (const [name, value] of Object.entries(names)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return run();
  } finally {
    restore();
  }
}

function node(permissions: Partial<AgentNode['permissions']>, provider: AgentNode['provider'] = 'openai'): AgentNode {
  return {
    id: 'n',
    label: 'Node',
    provider,
    model: 'test-model',
    prompt: 'test',
    position: { x: 0, y: 0 },
    permissions: { read: false, write: false, bash: false, web: false, email_read: false, mcp: false, ...permissions },
  };
}

async function toolkitFor(permissions: Partial<AgentNode['permissions']>, limits: Partial<{ bashTimeoutMs: number }> = {}) {
  const workspace = await Workspace.open(tempRoot());
  const toolkit = createNodeToolkit({
    node: node(permissions),
    workspace,
    limits: {
      bashTimeoutMs: limits.bashTimeoutMs ?? 10_000,
      outputLimitBytes: 8192,
      outputSaveLimitBytes: 65536,
      webFetchTimeoutMs: 5000,
      webFetchLimitBytes: 65536,
    },
    signal: new AbortController().signal,
  });
  return { toolkit, workspace };
}

/** A local server that records whether anything reached it. */
async function localServer(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.end('local secret');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --- 1. web_fetch ------------------------------------------------------------

test('web_fetch refuses loopback written in any IPv4, IPv6, mapped or NAT64 form', async () => {
  const server = await localServer();
  const { toolkit } = await toolkitFor({ web: true });
  try {
    for (const host of [
      '127.0.0.1',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[64:ff9b::7f00:1]',
      '[::127.0.0.1]',
      '[::1]',
      '2130706433',
      'localhost',
    ]) {
      const result = await toolkit.execute('web_fetch', { url: `http://${host}:${server.port}/` });
      assert.match(result, /^Error: .*cannot be fetched/, `${host} must be refused, got: ${result}`);
      assert.doesNotMatch(result, /local secret/);
    }
    assert.equal(server.hits(), 0, 'nothing may reach the local server');
  } finally {
    await server.close();
  }
});

test('web_fetch refuses the cloud metadata address in mapped form', async () => {
  const { toolkit } = await toolkitFor({ web: true });
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:169.254.169.254]/latest/meta-data/']) {
    assert.match(await toolkit.execute('web_fetch', { url }), /^Error: .*cannot be fetched/);
  }
});

test('reserved ranges are blocked and public addresses are not', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '172.16.0.1',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.251',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2002:7f00:1::',
    '64:ff9b::a9fe:a9fe',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(address), false, `${address} must be allowed`);
  }
});

function lookupWith(resolve: Resolver, options: { all?: boolean; family?: number } = {}) {
  return new Promise<{ error: Error | null; address: unknown }>((done) => {
    guardedLookup(resolve)('example.test', options, (error, address) => done({ error, address }));
  });
}

test('a hostname that resolves to a private address is refused at connect time', async () => {
  const local = await lookupWith(async () => [{ address: '127.0.0.1', family: 4 }]);
  assert.match(local.error?.message ?? '', /resolves to 127\.0\.0\.1/);

  const mixed = await lookupWith(async () => [
    { address: '93.184.215.14', family: 4 },
    { address: '::ffff:169.254.169.254', family: 6 },
  ]);
  assert.match(mixed.error?.message ?? '', /169\.254\.169\.254/);
});

test('a failed or empty lookup refuses instead of skipping the check', async () => {
  const failed = await lookupWith(async () => {
    throw new Error('ENOTFOUND');
  });
  assert.match(failed.error?.message ?? '', /could not be resolved/);

  const empty = await lookupWith(async () => []);
  assert.match(empty.error?.message ?? '', /did not resolve/);
});

test('a public answer is passed to the socket in the shape it asked for', async () => {
  const records = [
    { address: '93.184.215.14', family: 4 },
    { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
  ];
  const single = await lookupWith(async () => records);
  assert.equal(single.error, null);
  assert.equal(single.address, '93.184.215.14');

  const all = await lookupWith(async () => records, { all: true, family: 6 });
  assert.deepEqual(all.address, [records[1]]);
});

test('DNS rebinding: the address is checked by the lookup the connection itself uses', async () => {
  const server = await localServer();
  // A hostile name whose answer for the connection is local, whatever it said before.
  const rebinding: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(rebinding) } });
  try {
    await assert.rejects(
      fetch(`http://rebind.test:${server.port}/`, { dispatcher }),
      (error: Error) => /resolves to 127\.0\.0\.1/.test(String((error.cause as Error | undefined)?.message)),
    );
    assert.equal(server.hits(), 0);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

// --- 2. env loading, provider addresses, tracing ------------------------------

test('the default env file lives in the data directory, not the current directory', () => {
  const dataDir = tempRoot();
  fs.writeFileSync(path.join(dataDir, '.env'), 'LEAFI_SECURITY_TEST=from-data-dir\n');
  withEnv({ LEAFI_SECURITY_TEST: undefined }, () => {
    const file = loadEnvironment({ dataDir });
    assert.equal(file, path.join(dataDir, '.env'));
    assert.notEqual(path.dirname(file), process.cwd());
    assert.equal(process.env.LEAFI_SECURITY_TEST, 'from-data-dir');
  });
});

test('provider addresses ignore base-URL and gateway variables', () => {
  withEnv(
    {
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GOOGLE_API_KEY: 'g-test',
      OPENAI_BASE_URL: 'https://attacker.example/v1',
      OPENAI_API_BASE: 'https://attacker.example/v1',
      ANTHROPIC_BASE_URL: 'https://attacker.example',
      ANTHROPIC_API_URL: 'https://attacker.example',
      LANGSMITH_GATEWAY: 'https://attacker.example',
    },
    () => {
      const factory = new ModelFactory(new RuntimeConfig({ dataDir: tempRoot() }));
      const openai = factory.create(node({}, 'openai')) as unknown as { clientConfig: { baseURL: string } };
      const anthropic = factory.create(node({}, 'anthropic')) as unknown as { apiUrl: string };
      const google = factory.create(node({}, 'google')) as unknown as { baseUrl: string };
      assert.equal(openai.clientConfig.baseURL, 'https://api.openai.com/v1');
      assert.equal(anthropic.apiUrl, 'https://api.anthropic.com');
      assert.equal(google.baseUrl, 'https://generativelanguage.googleapis.com');
    },
  );
});

test('LangSmith tracing is switched off unless leafi opts in', () => {
  const switches = { LANGSMITH_TRACING: 'true', LANGCHAIN_TRACING_V2: 'true', LANGCHAIN_TRACING: 'true' };
  withEnv({ ...switches, [TRACING_OPT_IN]: undefined }, () => {
    disableImplicitTracing();
    for (const name of Object.keys(switches)) {
      assert.equal(process.env[name], undefined, `${name} must be cleared`);
    }
  });
  withEnv({ ...switches, [TRACING_OPT_IN]: 'true' }, () => {
    disableImplicitTracing();
    assert.equal(process.env.LANGSMITH_TRACING, 'true');
  });
});

// --- 3. MCP server home ---------------------------------------------------------

test('the MCP home is created owner-only', { skip: !POSIX }, async () => {
  const home = path.join(tempRoot(), 'mcp-home');
  await privateHome(home);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
});

test('an MCP home open to other accounts is refused', { skip: !POSIX }, async () => {
  const home = path.join(tempRoot(), 'mcp-home');
  fs.mkdirSync(home, { mode: 0o777 });
  fs.chmodSync(home, 0o777);
  await assert.rejects(privateHome(home), /other accounts can access it/);
});

// --- 4. pinned MCP launcher ---------------------------------------------------

test('the default MCP launcher names an exact version', () => {
  assert.match(DEFAULT_MCP_COMMAND, /chrome-devtools-mcp@\d+\.\d+\.\d+\s/);
  withEnv({ LEAFI_MCP_COMMAND: undefined }, () => {
    assert.equal(new RuntimeConfig({ dataDir: tempRoot() }).mcpCommand, DEFAULT_MCP_COMMAND);
  });
});

// --- 5. run record permissions --------------------------------------------------

test('run records are owner-only', { skip: !POSIX }, async () => {
  const dataDir = path.join(tempRoot(), 'data');
  const config = new RuntimeConfig({ dataDir });
  const store = new RunStore(config);
  await store.ensureLayout();
  const run = store.createRun({ id: 'g', name: 'g', nodes: [], edges: [] } as unknown as Graph, 'secret input', 'cli');
  await store.writeRun(run);
  const workspace = await store.createRunWorkspace(run.id);
  const sink = await RunEventSink.open({ runId: run.id, file: store.eventsFile(run.id) });
  await sink.record('node_started');
  await sink.close();

  for (const dir of [dataDir, config.runsDir, config.workspacesDir, workspace, path.dirname(store.eventsFile(run.id))]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `${dir} must be 0700`);
  }
  for (const file of [path.join(config.runsDir, run.id, 'meta.json'), store.eventsFile(run.id)]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${file} must be 0600`);
  }
});

test('an existing data directory is tightened', { skip: !POSIX }, async () => {
  const dataDir = path.join(tempRoot(), 'data');
  fs.mkdirSync(dataDir, { mode: 0o775 });
  fs.chmodSync(dataDir, 0o775);
  await new RunStore(new RuntimeConfig({ dataDir })).ensureLayout();
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
});

// --- 6. MCP concurrent-run limit ------------------------------------------------

function slowRuns(started: { count: number }, fail = false): RunService {
  return {
    async start(): Promise<StartedRun> {
      started.count += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (fail) {
        throw new Error('preflight failed');
      }
      const run = { id: `run-${started.count}`, status: 'running', startedAt: new Date().toISOString() } as Run;
      return { run, done: new Promise<Run>(() => undefined) };
    },
  } as unknown as RunService;
}

const POLICY = { maxConcurrentRuns: 2, allowBash: true, allowWrite: true, allowWeb: true, allowEmail: true, allowMcp: true } as McpPolicy;
const EMPTY_GRAPH = { id: 'g', name: 'g', nodes: [], edges: [] } as unknown as Graph;

test('simultaneous start_run calls cannot exceed the concurrent-run limit', async () => {
  const started = { count: 0 };
  const manager = new RunManager(slowRuns(started), {} as RunStore, POLICY);
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => manager.start(EMPTY_GRAPH, '')));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
  assert.equal(started.count, 2, 'only two runs may reach pre-flight');
});

test('a start that fails releases its slot', async () => {
  const started = { count: 0 };
  const failing = new RunManager(slowRuns(started, true), {} as RunStore, POLICY);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(failing.start(EMPTY_GRAPH, ''), /preflight failed/);
  }
  assert.equal(started.count, 3);
});

// --- 7. process groups ----------------------------------------------------------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

test('a bash timeout kills what the shell started, and does not wait for it', { skip: !POSIX }, async () => {
  const { toolkit, workspace } = await toolkitFor({ bash: true }, { bashTimeoutMs: 500 });
  const startedAt = Date.now();
  const result = await toolkit.execute('run_bash', { command: 'sleep 60 & echo $! > bg.pid; sleep 60' });
  assert.match(result, /^Killed after 500ms/);
  assert.ok(Date.now() - startedAt < 5000, 'a background child holding stdout must not keep the tool waiting');

  const pid = Number(fs.readFileSync(path.join(workspace.root, 'bg.pid'), 'utf8').trim());
  assert.ok(await waitFor(() => !alive(pid), 2000), `background process ${pid} must be killed`);
});

const FAKE_MCP_SERVER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], String(child.pid));
process.on('SIGTERM', () => {}); // a server that ignores SIGTERM still has to go
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.id === undefined) continue;
    const result = message.method === 'tools/list' ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`;

test('closing an MCP client stops everything the server started', { skip: !POSIX }, async () => {
  const root = tempRoot();
  const script = path.join(root, 'server.cjs');
  const pidFile = path.join(root, 'child.pid');
  fs.writeFileSync(script, FAKE_MCP_SERVER);

  const client = await connectMcpClient({
    command: `${process.execPath} ${script} ${pidFile}`,
    dataDir: root,
    timeoutMs: 5000,
    env: { PATH: process.env.PATH },
  });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));

  await client.close();
  assert.ok(await waitFor(() => !alive(pid), 6000), `server child ${pid} must be killed`);
});

// --- 8. placeholders ------------------------------------------------------------

test('unexpanded ${VAR} placeholders count as unset in every setting', () => {
  withEnv(
    {
      LEAFI_EMAIL_ADDRESS: '${LEAFI_EMAIL_ADDRESS}',
      LEAFI_EMAIL_APP_PASSWORD: '${LEAFI_EMAIL_APP_PASSWORD}',
      LEAFI_MCP_COMMAND: '${LEAFI_MCP_COMMAND}',
      LEAFI_MCP_TOOLS: '${LEAFI_MCP_TOOLS}',
      DATA_DIR: '${DATA_DIR}',
      LEAFI_HOME: '${PLUGIN_DATA}',
      // A home of its own, so a data folder on this machine cannot change the answer.
      HOME: tempRoot(),
      USERPROFILE: undefined,
    },
    () => {
      const config = new RuntimeConfig();
      assert.equal(config.emailCredentials(), undefined);
      assert.equal(config.mcpCommand, DEFAULT_MCP_COMMAND);
      assert.ok(!config.mcpTools.includes('${LEAFI_MCP_TOOLS}'));
      assert.equal(config.dataDir, path.join(os.homedir(), '.leafi'));
    },
  );

  withEnv(
    { LEAFI_EMAIL_ADDRESS: 'me@example.com', LEAFI_EMAIL_APP_PASSWORD: 'app-pass', LEAFI_EMAIL_IMAP_HOST: '${LEAFI_EMAIL_IMAP_HOST}' },
    () => {
      assert.equal(new RuntimeConfig({ dataDir: tempRoot() }).emailCredentials()?.imapHost, 'imap.gmail.com');
    },
  );
});
