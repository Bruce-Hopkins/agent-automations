import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, type ElicitRequestFormParams, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { FlowLibrary, flowSlug } from '../src/app/flow-library';
import { FlowService } from '../src/app/flow-service';
import { validateFlow } from '../src/app/flow-validation';
import { RuntimeConfig } from '../src/config/runtime-config';
import { lintParallelLimit } from '../src/domain/flow-lint';
import { requestPermissions, type AskPerson } from '../src/mcp/permission-request';
import { PolicyError, type McpPolicy } from '../src/mcp/policy';

const POSIX = process.platform !== 'win32';
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-library-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const node = (id: string, permissions: Record<string, boolean> = {}) => ({
  id,
  label: id.toUpperCase(),
  provider: 'openai',
  model: 'gpt-4o-mini',
  prompt: 'answer',
  permissions,
});

function flow(nodes: ReturnType<typeof node>[], edges: Record<string, string>[] = [], name = 'Test flow') {
  return { name, nodes, edges };
}

const DENY_ALL: McpPolicy = {
  allowBash: false,
  allowWrite: false,
  allowWeb: false,
  allowEmail: false,
  allowMcp: false,
  allowFlowPaths: true,
  maxConcurrentRuns: 1,
  maxFlowBytes: 100_000,
  maxResultBytes: 100_000,
};

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** An `ask` that records each question and gives one answer. */
function answering(result: ElicitResult): AskPerson & { questions: ElicitRequestFormParams[] } {
  const questions: ElicitRequestFormParams[] = [];
  const ask = async (params: ElicitRequestFormParams) => {
    questions.push(params);
    return result;
  };
  return Object.assign(ask, { questions });
}

// ---- The flow library ----

test('a flow name becomes a safe file name', () => {
  assert.equal(flowSlug('Weekly AI digest!'), 'weekly-ai-digest');
  assert.equal(flowSlug('../../etc/passwd'), 'etc-passwd');
  assert.equal(flowSlug('   '), 'flow');
  assert.equal(flowSlug('Café résumé'), 'cafe-resume');
});

test('the library saves a flow as written, replaces one with the same name, and lists newest first', async () => {
  const library = new FlowLibrary(new RuntimeConfig({ dataDir: tempDir() }));
  assert.deepEqual(await library.list(), []);

  const first = { name: 'Digest', nodes: [node('a')], edges: [] };
  const file = await library.save('Digest', first);
  assert.equal(file, path.join(library.dir, 'digest.json'));
  assert.deepEqual((await library.read('Digest'))?.document, first);

  const second = { name: 'Digest', nodes: [node('a'), node('b')], edges: [{ source: 'a', target: 'b' }] };
  assert.equal(await library.save('Digest', second), file);
  await library.save('Other', { name: 'Other', nodes: [node('c')], edges: [] });

  const listed = await library.list();
  assert.deepEqual(listed.map(({ name, nodes }) => ({ name, nodes })).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'Digest', nodes: 2 },
    { name: 'Other', nodes: 1 },
  ]);
  assert.equal(await library.read('Missing'), undefined);
});

test('saved flows are readable by their owner only', { skip: !POSIX }, async () => {
  const library = new FlowLibrary(new RuntimeConfig({ dataDir: tempDir() }));
  const file = await library.save('Private', { name: 'Private', nodes: [], edges: [] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(library.dir).mode & 0o777, 0o700);
});

// ---- Asking the person for a permission ----

test('a flow needing nothing that is turned off asks nothing', async () => {
  const ask = answering({ action: 'decline' });
  const granted = await requestPermissions(new FlowService().loadPayload(flow([node('a', { read: true })])), { policy: DENY_ALL, logger: quietLogger }, ask);
  assert.equal(granted.size, 0);
  assert.equal(ask.questions.length, 0);
});

test('without a way to ask, the refusal names the command that allows it', async () => {
  const graph = new FlowService().loadPayload(flow([node('a', { bash: true })]));
  await assert.rejects(
    requestPermissions(graph, { policy: DENY_ALL, logger: quietLogger }, undefined),
    (error: unknown) => error instanceof PolicyError && /settings --allow bash`/.test(error.message),
  );
});

test('the question names each permission and its nodes, and accepting allows them for this run only', async () => {
  const settingsFile = path.join(tempDir(), '.env');
  const policy = { ...DENY_ALL };
  const graph = new FlowService().loadPayload(flow([node('a', { bash: true }), node('b', { bash: true, mcp: true })]));
  // Hermes accepts with no fields at all.
  const ask = answering({ action: 'accept', content: {} });

  const granted = await requestPermissions(graph, { policy, settingsFile, logger: quietLogger }, ask);

  assert.deepEqual([...granted].sort(), ['LEAFI_ALLOW_BASH', 'LEAFI_ALLOW_MCP']);
  const message = ask.questions[0]?.message ?? '';
  assert.match(message, /- bash: run shell commands .*Nodes: "A", "B"\./);
  assert.match(message, /- mcp: .*Nodes: "B"\./);
  assert.ok(ask.questions[0]?.requestedSchema.properties.always, 'a server with a settings file offers "always"');
  assert.equal(policy.allowBash, false);
  assert.equal(fs.existsSync(settingsFile), false);
});

test('"always" saves the permission to the settings file and allows it for the rest of the session', async () => {
  const settingsFile = path.join(tempDir(), '.env');
  fs.writeFileSync(settingsFile, 'OPENAI_API_KEY=sk-test\n');
  const policy = { ...DENY_ALL };
  const graph = new FlowService().loadPayload(flow([node('a', { bash: true })]));

  await requestPermissions(graph, { policy, settingsFile, logger: quietLogger }, answering({ action: 'accept', content: { always: true } }));

  assert.equal(policy.allowBash, true);
  const saved = fs.readFileSync(settingsFile, 'utf8');
  assert.match(saved, /^OPENAI_API_KEY=sk-test$/m);
  assert.match(saved, /^LEAFI_ALLOW_BASH=true$/m);
});

test('a server that read no settings file offers no "always", and says how to stop being asked', async () => {
  const graph = new FlowService().loadPayload(flow([node('a', { mcp: true })]));
  const ask = answering({ action: 'accept', content: {} });
  await requestPermissions(graph, { policy: { ...DENY_ALL }, logger: quietLogger }, ask);
  assert.deepEqual(ask.questions[0]?.requestedSchema.properties, {});
  assert.match(ask.questions[0]?.message ?? '', /To stop being asked, run: .* settings --allow mcp/);
});

test('declining, cancelling or a failed question refuses the flow', async () => {
  const graph = new FlowService().loadPayload(flow([node('a', { bash: true })]));
  const context = { policy: DENY_ALL, logger: quietLogger };
  for (const result of [{ action: 'decline' }, { action: 'cancel' }] as const) {
    await assert.rejects(requestPermissions(graph, context, answering(result)), /did not allow this flow.*settings --allow bash/);
  }
  const failing: AskPerson = async () => {
    throw new Error('Request timed out');
  };
  await assert.rejects(requestPermissions(graph, context, failing), /could not be asked.*settings --allow bash/);
});

// ---- MAX_PARALLEL_NODES=1 ----

test('MAX_PARALLEL_NODES=1 warns only for a flow where two nodes can be ready at once', () => {
  const service = new FlowService();
  const chain = service.loadPayload(flow([node('a'), node('b')], [{ source: 'a', target: 'b' }]));
  const twoEntries = service.loadPayload(flow([node('a'), node('b'), node('c')], [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }]));
  const branch = service.loadPayload(
    flow([node('a'), node('b'), node('c')], [
      { source: 'a', target: 'b', branch: 'yes', condition: 'score > 5' },
      { source: 'a', target: 'c', branch: 'no', condition: 'score <= 5' },
    ]),
  );

  assert.deepEqual(lintParallelLimit(chain, 1), []);
  assert.deepEqual(lintParallelLimit(twoEntries, 4), []);
  assert.match(lintParallelLimit(twoEntries, 1)[0]?.message ?? '', /2 entry nodes/);
  assert.match(lintParallelLimit(branch, 1)[0]?.message ?? '', /"A" has several outgoing edges/);
});

test('validate reports the parallel-limit warning from the setting', () => {
  const previous = process.env.MAX_PARALLEL_NODES;
  process.env.MAX_PARALLEL_NODES = '1';
  try {
    const graph = new FlowService().loadPayload(
      flow([node('a'), node('b'), node('c')], [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }]),
    );
    const validation = validateFlow(graph, new RuntimeConfig({ dataDir: tempDir() }));
    assert.equal(validation.ok, true);
    assert.ok(validation.warnings.some((warning) => warning.code === 'parallel-limit-one'));
  } finally {
    if (previous === undefined) {
      delete process.env.MAX_PARALLEL_NODES;
    } else {
      process.env.MAX_PARALLEL_NODES = previous;
    }
  }
});

// ---- Over MCP ----

async function connect(dataDir: string, answer?: ElicitResult) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/mcp/main.js'), '--transport', 'stdio', '--data-dir', dataDir],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'leafi-test', version: '1.0.0' }, { capabilities: answer ? { elicitation: {} } : {} });
  const questions: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      questions.push(String(request.params.message));
      return answer;
    });
  }
  await client.connect(transport);
  return { client, questions };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((part) => part.text ?? '').join('');
}

test('over MCP, start_run asks the person, saves "always", and saves the flow for list_flows and get_flow', { timeout: 20000 }, async () => {
  const dataDir = tempDir();
  const { client, questions } = await connect(dataDir, { action: 'accept', content: { always: true } });
  try {
    const document = flow([node('a', { bash: true })], [], 'Nightly check');
    const started = await client.callTool({ name: 'start_run', arguments: { flow: document } });

    // The person allowed it, so what stops the run is the missing provider key,
    // before any model call.
    assert.equal(started.isError, true);
    assert.match(textOf(started), /No API key is configured/);
    assert.equal(questions.length, 1);
    assert.match(questions[0] ?? '', /bash: run shell commands/);
    assert.match(fs.readFileSync(path.join(dataDir, '.env'), 'utf8'), /^LEAFI_ALLOW_BASH=true$/m);

    // Allowed for the rest of the session: no second question.
    await client.callTool({ name: 'start_run', arguments: { flow: document } });
    assert.equal(questions.length, 1);

    const listed = JSON.parse(textOf(await client.callTool({ name: 'list_flows', arguments: {} })));
    assert.deepEqual(listed.flows.map((entry: { name: string; nodes: number }) => [entry.name, entry.nodes]), [['Nightly check', 1]]);
    const saved = JSON.parse(textOf(await client.callTool({ name: 'get_flow', arguments: { name: 'Nightly check' } })));
    assert.deepEqual(saved.flow, document);
    assert.equal(saved.file, path.join(dataDir, 'flows', 'nightly-check.json'));
  } finally {
    await client.close();
  }
});

test('over MCP, a client that cannot ask gets the refusal and nothing is saved', { timeout: 20000 }, async () => {
  const dataDir = tempDir();
  const { client } = await connect(dataDir);
  try {
    const started = await client.callTool({ name: 'start_run', arguments: { flow: flow([node('a', { mcp: true })]) } });
    assert.equal(started.isError, true);
    assert.match(textOf(started), /settings --allow mcp`/);
    assert.equal(fs.existsSync(path.join(dataDir, 'flows')), false);
  } finally {
    await client.close();
  }
});

test('over MCP, a declined question refuses the run', { timeout: 20000 }, async () => {
  const dataDir = tempDir();
  const { client, questions } = await connect(dataDir, { action: 'decline' });
  try {
    const started = await client.callTool({ name: 'start_run', arguments: { flow: flow([node('a', { bash: true })]) } });
    assert.equal(started.isError, true);
    assert.match(textOf(started), /did not allow this flow/);
    assert.equal(questions.length, 1);
    assert.equal(fs.existsSync(path.join(dataDir, '.env')) && /ALLOW_BASH=true/.test(fs.readFileSync(path.join(dataDir, '.env'), 'utf8')), false);
  } finally {
    await client.close();
  }
});
