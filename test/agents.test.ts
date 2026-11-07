import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addToMcpConfig, findAgents, findCommand, mcpEntry, type Agent } from '../src/mcp/agents';

const tempDirs: string[] = [];
const ENV_NAMES = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'FAKE_LOG', 'FAKE_HERMES_STATE'] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const posixOnly = { skip: process.platform === 'win32' ? 'the stand-in commands are shell scripts' : false };

/**
 * A stand-in for hermes: `plugins show` reports the state file ("missing",
 * "not enabled" or "enabled"), install and enable set it to enabled (an
 * install from the source "fail" exits 2), and every call is logged.
 */
const FAKE_HERMES = `#!/bin/sh
echo "hermes $*" >> "$FAKE_LOG"
read -r state < "$FAKE_HERMES_STATE"
case "$1 $2" in
  "plugins show")
    if [ "$3" = agents-automations ]; then
      [ -f "$FAKE_HERMES_STATE.legacy" ] || exit 1
      printf '\\nagents-automations v0.0.2\\nStatus: enabled\\n'
      exit 0
    fi
    [ "$state" = missing ] && exit 1
    printf '\\nleafi v0.0.1\\nStatus: %s\\n' "$state" ;;
  "plugins install")
    [ "$3" = fail ] && exit 2
    echo enabled > "$FAKE_HERMES_STATE" ;;
  "plugins enable")
    echo enabled > "$FAKE_HERMES_STATE" ;;
esac
`;

/** A stand-in for claude that logs its arguments and succeeds. */
const FAKE_CLAUDE = `#!/bin/sh
echo "claude $*" >> "$FAKE_LOG"
`;

interface Machine {
  home: string;
  calls(): string[];
}

/**
 * A home folder of its own, with only the given stand-in commands on the PATH
 * (and nothing else, so no real agent is ever found), and Hermes's plugin in
 * `hermesState`.
 */
function machine(commands: { hermes?: string; claude?: boolean; legacyHermes?: boolean } = {}): Machine {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-agents-'));
  tempDirs.push(home);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(home, 'log');
  if (commands.hermes) {
    fs.writeFileSync(path.join(bin, 'hermes'), FAKE_HERMES, { mode: 0o755 });
    fs.writeFileSync(path.join(home, 'hermes-state'), `${commands.hermes}\n`);
    if (commands.legacyHermes) {
      fs.writeFileSync(path.join(home, 'hermes-state.legacy'), '');
    }
  }
  if (commands.claude) {
    fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  }
  process.env.PATH = bin;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.FAKE_LOG = log;
  process.env.FAKE_HERMES_STATE = path.join(home, 'hermes-state');
  return { home, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function byId(agents: Agent[], id: Agent['id']): Agent {
  const agent = agents.find((candidate) => candidate.id === id);
  assert.ok(agent, `${id} was not found`);
  return agent;
}

test('findAgents lists only the agents this machine has, and changes nothing', posixOnly, async () => {
  const m = machine({ claude: true });
  fs.mkdirSync(path.join(m.home, '.cursor'));

  const agents = await findAgents('owner/repo/hermes-plugin');

  assert.deepEqual(agents.map((agent) => agent.id), ['claude-code', 'cursor']);
  assert.deepEqual(m.calls(), [], 'finding runs no agent command');
  assert.equal(fs.existsSync(path.join(m.home, '.cursor', 'mcp.json')), false);
});

test('a missing Hermes plugin is installed with --enable from the given source', posixOnly, async () => {
  const m = machine({ hermes: 'missing' });
  const hermes = byId(await findAgents('owner/repo/hermes-plugin'), 'hermes');

  assert.match(hermes.detail, /installs and enables/);
  const result = await hermes.install('/srv/server.mjs');

  assert.deepEqual(m.calls(), [
    'hermes plugins show leafi',
    'hermes plugins install owner/repo/hermes-plugin --enable',
    'hermes plugins show leafi',
    'hermes plugins show agents-automations',
  ]);
  assert.deepEqual(result, { ok: true, line: 'Hermes: installed and enabled the plugin from owner/repo/hermes-plugin.' });
});

test('an installed but disabled plugin is enabled, not reinstalled, and an enabled one is left alone', posixOnly, async () => {
  const disabled = machine({ hermes: 'not enabled' });
  const result = await byId(await findAgents('owner/repo/hermes-plugin'), 'hermes').install('/srv/server.mjs');
  assert.deepEqual(disabled.calls().slice(1), ['hermes plugins enable leafi', 'hermes plugins show leafi', 'hermes plugins show agents-automations']);
  assert.deepEqual(result, { ok: true, line: 'Hermes: enabled the plugin.' });

  const enabled = machine({ hermes: 'enabled' });
  const hermes = byId(await findAgents('owner/repo/hermes-plugin'), 'hermes');
  assert.match(hermes.detail, /installed and enabled/);
  assert.equal((await hermes.install('/srv/server.mjs')).ok, true);
  assert.deepEqual(enabled.calls(), ['hermes plugins show leafi', 'hermes plugins show agents-automations']);
});

test('the plugin from before the rename is pointed out, not removed: its data holds saved flows', posixOnly, async () => {
  const m = machine({ hermes: 'enabled', legacyHermes: true });
  const result = await byId(await findAgents('owner/repo/hermes-plugin'), 'hermes').install('/srv/server.mjs');

  assert.equal(result.ok, true);
  assert.match(result.line, /agents-automations, is still installed.*"hermes plugins remove agents-automations"/);
  assert.ok(!m.calls().some((call) => /remove|uninstall/.test(call)), 'nothing is removed');
});

test('a failed Hermes install is reported with the command that failed', posixOnly, async () => {
  machine({ hermes: 'missing' });
  const result = await byId(await findAgents('fail'), 'hermes').install('/srv/server.mjs');

  assert.equal(result.ok, false);
  assert.match(result.line, /"hermes plugins install fail --enable" failed \(exit 2\)/);
});

test('Claude Code gets the server at user scope, unless its settings already list it', posixOnly, async () => {
  const m = machine({ claude: true });
  const claude = byId(await findAgents(), 'claude-code');
  const result = await claude.install('/srv/server.mjs');

  assert.deepEqual(m.calls(), ['claude mcp add --scope user leafi -- node /srv/server.mjs --transport stdio']);
  assert.deepEqual(result, { ok: true, line: 'Claude Code: added the server for all projects.' });

  const again = machine({ claude: true });
  fs.writeFileSync(path.join(again.home, '.claude.json'), JSON.stringify({ mcpServers: { leafi: {} } }));
  const added = byId(await findAgents(), 'claude-code');
  assert.match(added.detail, /already added/);
  assert.equal((await added.install('/srv/server.mjs')).ok, true);
  assert.deepEqual(again.calls(), [], 'nothing is run for a server that is already there');
});

test("Claude Code's entry from before the rename is removed when the server is added", posixOnly, async () => {
  const m = machine({ claude: true });
  fs.writeFileSync(path.join(m.home, '.claude.json'), JSON.stringify({ mcpServers: { 'agents-automations': {} } }));
  const result = await byId(await findAgents(), 'claude-code').install('/srv/server.mjs');

  assert.deepEqual(m.calls(), [
    'claude mcp remove --scope user agents-automations',
    'claude mcp add --scope user leafi -- node /srv/server.mjs --transport stdio',
  ]);
  assert.deepEqual(result, { ok: true, line: 'Claude Code: added the server for all projects and removed the old agents-automations entry.' });
});

test("Cursor's mcp.json gets the server's entry, keeping every other server and setting", posixOnly, async () => {
  const m = machine();
  const file = path.join(m.home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'other' } }, theme: 'dark' }));

  const cursor = byId(await findAgents(), 'cursor');
  assert.equal(cursor.detail, 'adds the server to ~/.cursor/mcp.json');
  assert.deepEqual(await cursor.install('/srv/server.mjs'), { ok: true, line: 'Cursor: added the server to ~/.cursor/mcp.json.' });

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    mcpServers: { other: { command: 'other' }, leafi: mcpEntry('/srv/server.mjs') },
    theme: 'dark',
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await byId(await findAgents(), 'cursor').install('/srv/server.mjs')).line, 'Cursor: the server was already added.');
});

test("Claude Desktop's settings file is created when the app has none yet", posixOnly, async () => {
  const m = machine();
  const dir = process.platform === 'darwin' ? path.join(m.home, 'Library', 'Application Support', 'Claude') : path.join(m.home, '.config', 'Claude');
  fs.mkdirSync(dir, { recursive: true });

  const result = await byId(await findAgents(), 'claude-desktop').install('/srv/server.mjs');

  assert.equal(result.ok, true, result.line);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claude_desktop_config.json'), 'utf8')), {
    mcpServers: { leafi: mcpEntry('/srv/server.mjs') },
  });
});

test('a settings file that is not a JSON object is refused and left as it was', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-mcp-config-'));
  tempDirs.push(dir);
  const cases = { 'broken.json': '{ "mcpServers": ', 'list.json': '[]', 'servers.json': '{ "mcpServers": [] }' };
  for (const [name, content] of Object.entries(cases)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    await assert.rejects(addToMcpConfig(file, mcpEntry('/srv/server.mjs')), /not valid JSON|not a JSON object|"mcpServers" is not an object/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('a changed server path updates the entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-mcp-config-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'mcp.json');

  assert.equal(await addToMcpConfig(file, mcpEntry('/old/server.mjs')), 'added');
  assert.equal(await addToMcpConfig(file, mcpEntry('/old/server.mjs')), 'unchanged');
  assert.equal(await addToMcpConfig(file, mcpEntry('/new/server.mjs')), 'updated');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.leafi.args[0], '/new/server.mjs');
});

test('the entry from before the rename is replaced, keeping every other server', posixOnly, async () => {
  const m = machine();
  const file = path.join(m.home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'agents-automations': { command: 'node', args: ['/old/server.mjs'] }, other: {} } }));

  const cursor = byId(await findAgents(), 'cursor');
  assert.equal(cursor.detail, 'replaces the old agents-automations entry in ~/.cursor/mcp.json');
  assert.deepEqual(await cursor.install('/srv/server.mjs'), { ok: true, line: 'Cursor: updated the server in ~/.cursor/mcp.json.' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, { other: {}, leafi: mcpEntry('/srv/server.mjs') });
});

test('the entry names the node on the PATH, which survives an upgrade, else this process\'s own', posixOnly, () => {
  const m = machine();
  assert.equal(mcpEntry('/srv/server.mjs').command, process.execPath, 'no node on this PATH');
  fs.writeFileSync(path.join(m.home, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(mcpEntry('/srv/server.mjs'), { command: path.join(m.home, 'bin', 'node'), args: ['/srv/server.mjs', '--transport', 'stdio'] });
});

test('findCommand finds an executable on the PATH and skips a file that is not one', posixOnly, () => {
  const m = machine({ claude: true });
  fs.writeFileSync(path.join(m.home, 'bin', 'hermes'), 'not executable', { mode: 0o644 });

  assert.equal(findCommand('claude'), path.join(m.home, 'bin', 'claude'));
  assert.equal(findCommand('hermes'), undefined);
});
