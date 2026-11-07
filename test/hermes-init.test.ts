import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setEnvValues } from '../src/config/env-file';
import { hermesEnvFile } from '../src/mcp/hermes-home';
import { mcpEntry, type Agent } from '../src/mcp/agents';
import { AGENTS_QUESTION, initSettings, setup, type InitPrompts } from '../src/mcp/init';
import type { SettingsFile } from '../src/mcp/settings';

const tempDirs: string[] = [];

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-hermes-init-'));
  tempDirs.push(dir);
  return dir;
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

/** init's settings step for Hermes's file alone. */
async function initHermesSettings(envFile: string, prompts: InitPrompts) {
  const [result] = await initSettings([{ envFile, hermes: true }], prompts);
  assert.ok(result);
  return result;
}

/**
 * Answers init's questions: a provider number, the key, then the checklist.
 * `ticks` overrides items by their first word (`web`, `bash`, `flow-paths` ...);
 * every other item keeps the tick it was offered with, as Enter does.
 */
function scripted(
  choice: number,
  key: string,
  ticks: Record<string, boolean> = {},
): InitPrompts & { asked: string[]; offered: Record<string, boolean>; agentsOffered: string[] } {
  const asked: string[] = [];
  const offered: Record<string, boolean> = {};
  const agentsOffered: string[] = [];
  return {
    asked,
    offered,
    agentsOffered,
    choice: async (question, labels) => {
      asked.push(`${question} ${labels.join(' | ')}`);
      return choice;
    },
    secret: async (question) => {
      asked.push(question);
      return key;
    },
    checklist: async (question, items) => {
      asked.push(question);
      if (question === AGENTS_QUESTION) {
        // The agents checklist: ticks name an agent by its first word (Hermes, Claude, Cursor).
        return items.map((item) => {
          const word = item.label.split(' ')[0] ?? '';
          agentsOffered.push(`${item.checked ? '[x]' : '[ ]'} ${item.label.trim()}`);
          return ticks[word] ?? item.checked;
        });
      }
      return items.map((item) => {
        const word = item.label.split(' ')[0] ?? '';
        offered[word] = item.checked;
        return ticks[word] ?? item.checked;
      });
    },
  };
}

const NONE_BUT_FLOW_PATHS = { web: false, write: false, bash: false, email: false, mcp: false };

test("init keeps Hermes's own lines and writes only the answers that change the file", async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, '# Hermes\nHERMES_MODEL=nous/hermes\nexport OPENROUTER_API_KEY=old\nLEAFI_ALLOW_WRITE=true\n', { mode: 0o644 });

  const openrouter = 3;
  const result = await initHermesSettings(envFile, scripted(openrouter, 'sk-or-new', { bash: false, email: false, mcp: false }));

  assert.deepEqual(result.saved, ['OPENROUTER_API_KEY', 'LEAFI_ALLOW_WEB=true']);
  assert.equal(result.keyConfigured, true);
  assert.equal(
    fs.readFileSync(envFile, 'utf8'),
    '# Hermes\nHERMES_MODEL=nous/hermes\nOPENROUTER_API_KEY=sk-or-new\nLEAFI_ALLOW_WRITE=true\n\n# leafi plugin\nLEAFI_ALLOW_WEB=true\n',
  );
  if (process.platform !== 'win32') {
    assert.equal(mode(envFile), 0o600);
  }
  assert.deepEqual(fs.readdirSync(dir), ['.env'], 'no temporary file is left behind');
});

test('init marks a provider whose key is set, and Enter keeps every permission the file sets', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  const original =
    'ANTHROPIC_API_KEY=sk-ant-mine\nLEAFI_ALLOW_BASH=yes\nLEAFI_ALLOW_WRITE=no\nLEAFI_ALLOW_WEB=true\n' +
    'LEAFI_ALLOW_EMAIL=false\nLEAFI_ALLOW_MCP=1\nLEAFI_ALLOW_FLOW_PATHS=false\n';
  fs.writeFileSync(envFile, original);

  const prompts = scripted(1, '');
  const result = await initHermesSettings(envFile, prompts);

  assert.deepEqual(result.saved, []);
  assert.equal(result.keyConfigured, true);
  assert.equal(fs.readFileSync(envFile, 'utf8'), original);
  assert.match(prompts.asked[0] ?? '', /Anthropic \(key already set\)/);
  assert.match(prompts.asked[1] ?? '', /ANTHROPIC_API_KEY .*Enter to keep the current key/);
  assert.deepEqual(prompts.offered, { web: true, write: false, bash: true, email: false, mcp: true, 'flow-paths': false });
});

test('init offers the workspace permissions ticked and bash, email and mcp unticked, and Enter keeps that', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');

  const prompts = scripted(0, '');
  const result = await initHermesSettings(envFile, prompts);

  assert.deepEqual(prompts.offered, { web: true, write: true, bash: false, email: false, mcp: false, 'flow-paths': true });
  // The server already denies bash, email and mcp and allows flow paths
  // when they are unset, so only web and write are written.
  assert.deepEqual(result.saved, ['LEAFI_ALLOW_WEB=true', 'LEAFI_ALLOW_WRITE=true']);
  assert.equal(result.mailboxMissing, false);
});

test('init writes an untick only where the server would otherwise allow it', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'LEAFI_ALLOW_BASH=true\n');

  const result = await initHermesSettings(envFile, scripted(0, '', { ...NONE_BUT_FLOW_PATHS, 'flow-paths': false }));

  assert.deepEqual(result.saved, ['LEAFI_ALLOW_BASH=false', 'LEAFI_ALLOW_FLOW_PATHS=false']);
  assert.equal(result.mailboxMissing, false);
});

test('init reports no missing mailbox when the file has one', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'LEAFI_EMAIL_ADDRESS=me@example.com\nLEAFI_EMAIL_APP_PASSWORD=abcd\n');

  const result = await initHermesSettings(envFile, scripted(0, ''));

  assert.equal(result.mailboxMissing, false);
});

test('init creates a missing settings file, owner-only', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, 'hermes', '.env');

  const result = await initHermesSettings(envFile, scripted(0, 'sk-openai', NONE_BUT_FLOW_PATHS));

  assert.deepEqual(result.saved, ['OPENAI_API_KEY']);
  assert.equal(fs.readFileSync(envFile, 'utf8'), '# leafi plugin\nOPENAI_API_KEY=sk-openai\n');
  if (process.platform !== 'win32') {
    assert.equal(mode(envFile), 0o600);
    assert.equal(mode(path.dirname(envFile)), 0o700);
  }
});

test('init writes nothing when no key is given and every answer matches what the server reads', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');

  const result = await initHermesSettings(envFile, scripted(0, '', NONE_BUT_FLOW_PATHS));

  assert.deepEqual(result, { envFile, saved: [], keyConfigured: false, mailboxMissing: false });
  assert.equal(fs.existsSync(envFile), false);
});

test('init asks once and saves the key and permissions to every file, each under its own heading', async () => {
  const dir = tempDir();
  const hermes: SettingsFile = { envFile: path.join(dir, 'hermes', '.env'), hermes: true };
  const data: SettingsFile = { envFile: path.join(dir, 'data', '.env'), hermes: false };
  fs.mkdirSync(path.dirname(hermes.envFile));
  fs.writeFileSync(hermes.envFile, 'HERMES_MODEL=nous/hermes\n');

  const prompts = scripted(0, 'sk-openai', { write: false, bash: false, email: false, mcp: false });
  const results = await initSettings([hermes, data], prompts);

  assert.equal(prompts.asked.filter((question) => question.startsWith('Which provider')).length, 1);
  assert.deepEqual(results.map((result) => result.saved), [
    ['OPENAI_API_KEY', 'LEAFI_ALLOW_WEB=true'],
    ['OPENAI_API_KEY', 'LEAFI_ALLOW_WEB=true'],
  ]);
  assert.equal(
    fs.readFileSync(hermes.envFile, 'utf8'),
    'HERMES_MODEL=nous/hermes\n\n# leafi plugin\nOPENAI_API_KEY=sk-openai\nLEAFI_ALLOW_WEB=true\n',
  );
  assert.match(fs.readFileSync(data.envFile, 'utf8'), /^# leafi settings\. Every setting: https:.*\nOPENAI_API_KEY=sk-openai\nLEAFI_ALLOW_WEB=true\n$/);
});

test('across files, a key counts as set only when every file has it, and a permission one file denies is offered unticked', async () => {
  const dir = tempDir();
  const hermes = path.join(dir, 'hermes.env');
  const data = path.join(dir, 'data.env');
  fs.writeFileSync(hermes, 'ANTHROPIC_API_KEY=sk-ant\nOPENAI_API_KEY=sk-oa\nLEAFI_ALLOW_BASH=false\n');
  fs.writeFileSync(data, 'OPENAI_API_KEY=sk-oa\nLEAFI_ALLOW_BASH=true\nLEAFI_ALLOW_WEB=true\n');

  const prompts = scripted(0, '');
  const results = await initSettings([{ envFile: hermes, hermes: true }, { envFile: data, hermes: false }], prompts);

  assert.match(prompts.asked[0] ?? '', /OpenAI \(key already set\)/);
  assert.doesNotMatch(prompts.asked[0] ?? '', /Anthropic \(key already set\)/);
  assert.equal(prompts.offered.bash, false);
  assert.equal(prompts.offered.web, true);
  // Enter keeps bash denied: the file that allowed it now denies it too.
  assert.ok(results[1]?.saved.includes('LEAFI_ALLOW_BASH=false'));
});

test("init creates the data directory's file even with nothing to save, so settings finds it", async () => {
  const dir = tempDir();
  const data = path.join(dir, 'data', '.env');

  const [result] = await initSettings([{ envFile: data, hermes: false }], scripted(0, '', NONE_BUT_FLOW_PATHS));

  assert.deepEqual(result?.saved, []);
  assert.match(fs.readFileSync(data, 'utf8'), /^# leafi settings\. Every setting: /);
  if (process.platform !== 'win32') {
    assert.equal(mode(data), 0o600);
  }
});

/** An agent that records whether it was installed, and fails when asked to. */
function fakeAgent(id: Agent['id'], name: string, installed: string[], fail = false): Agent {
  return {
    id,
    name,
    detail: `adds the server to ${name}`,
    readsHermesEnv: id === 'hermes',
    install: async (server) => {
      installed.push(`${id} ${server}`);
      return { ok: !fail, line: `${name}: ${fail ? 'failed' : 'added'}.` };
    },
  };
}

/** Runs setup with Hermes's home and the data directory in a temp folder, and stderr captured. */
async function runSetupIn(dir: string, agents: Agent[], prompts: InitPrompts): Promise<{ code: number; stderr: string }> {
  const saved = { HERMES_HOME: process.env.HERMES_HOME, DATA_DIR: process.env.DATA_DIR, LEAFI_HOME: process.env.LEAFI_HOME };
  const write = process.stderr.write;
  let stderr = '';
  process.env.HERMES_HOME = path.join(dir, 'hermes');
  process.env.LEAFI_HOME = path.join(dir, 'data');
  delete process.env.DATA_DIR;
  process.stderr.write = ((chunk: string) => ((stderr += chunk), true)) as typeof process.stderr.write;
  try {
    const code = await setup({}, { prompts, agents, server: '/srv/server.mjs' });
    return { code, stderr };
  } finally {
    process.stderr.write = write;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test('setup offers every agent it found ticked, installs only the ticked ones, and saves where they read', async () => {
  const dir = tempDir();
  const installed: string[] = [];
  const agents = [fakeAgent('hermes', 'Hermes', installed), fakeAgent('claude-code', 'Claude Code', installed), fakeAgent('cursor', 'Cursor', installed)];
  const prompts = scripted(0, 'sk-openai', { ...NONE_BUT_FLOW_PATHS, Claude: false, Cursor: false });

  const { code, stderr } = await runSetupIn(dir, agents, prompts);

  assert.equal(code, 0, stderr);
  assert.equal(prompts.asked[0], AGENTS_QUESTION, 'where to install is the first question');
  assert.deepEqual(prompts.agentsOffered, [
    '[x] Hermes          adds the server to Hermes',
    '[x] Claude Code     adds the server to Claude Code',
    '[x] Cursor          adds the server to Cursor',
  ]);
  assert.deepEqual(installed, ['hermes /srv/server.mjs']);
  assert.equal(fs.readFileSync(path.join(dir, 'hermes', '.env'), 'utf8'), '# leafi plugin\nOPENAI_API_KEY=sk-openai\n');
  // Only Hermes was ticked, but the leafi command reads the data
  // directory's file, so the key goes there too.
  assert.match(fs.readFileSync(path.join(dir, 'data', '.env'), 'utf8'), /^OPENAI_API_KEY=sk-openai$/m);
  assert.match(stderr, /Hermes: added\./);
  assert.match(stderr, /Hermes: start a new session/);
});

test('setup saves to both files when Hermes and another agent are ticked, and fails when an install does', async () => {
  const dir = tempDir();
  const installed: string[] = [];
  const agents = [fakeAgent('hermes', 'Hermes', installed), fakeAgent('cursor', 'Cursor', installed, true)];

  const { code, stderr } = await runSetupIn(dir, agents, scripted(0, 'sk-openai', NONE_BUT_FLOW_PATHS));

  assert.equal(code, 1);
  assert.deepEqual(installed, ['hermes /srv/server.mjs', 'cursor /srv/server.mjs']);
  assert.match(fs.readFileSync(path.join(dir, 'hermes', '.env'), 'utf8'), /OPENAI_API_KEY=sk-openai/);
  assert.match(fs.readFileSync(path.join(dir, 'data', '.env'), 'utf8'), /OPENAI_API_KEY=sk-openai/);
  assert.match(stderr, /Cursor: failed\./);
});

test('setup with no agent found, or none ticked, installs nothing and says how to add the server by hand', async () => {
  for (const agents of [[], [fakeAgent('cursor', 'Cursor', [])]]) {
    const dir = tempDir();
    const installed: string[] = [];
    const prompts = scripted(0, '', { ...NONE_BUT_FLOW_PATHS, Cursor: false });
    const { code, stderr } = await runSetupIn(dir, agents.length ? [fakeAgent('cursor', 'Cursor', installed)] : [], prompts);

    assert.equal(code, 0, stderr);
    assert.deepEqual(installed, []);
    assert.equal(prompts.asked.includes(AGENTS_QUESTION), agents.length > 0);
    assert.ok(fs.existsSync(path.join(dir, 'data', '.env')));
    assert.match(stderr, /Add the server to your MCP client/);
    assert.ok(stderr.includes(`"leafi": ${JSON.stringify(mcpEntry('/srv/server.mjs'))}`), stderr);
  }
});

test("hermesEnvFile follows HERMES_HOME, as Hermes's profiles do", () => {
  const saved = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = '~/.hermes/profiles/work';
    assert.equal(hermesEnvFile(), path.join(os.homedir(), '.hermes', 'profiles', 'work', '.env'));
    delete process.env.HERMES_HOME;
    if (process.platform !== 'win32') {
      assert.equal(hermesEnvFile(), path.join(os.homedir(), '.hermes', '.env'));
    }
  } finally {
    if (saved === undefined) {
      delete process.env.HERMES_HOME;
    } else {
      process.env.HERMES_HOME = saved;
    }
  }
});

test('setEnvValues replaces every assignment of a name and quotes what dotenv would misread', () => {
  assert.equal(setEnvValues('A=1\n  A = 2\nB=3', { A: 'x' }), 'A=x\nA=x\nB=3');
  assert.equal(setEnvValues('', { A: 'has space' }), 'A="has space"\n');
  assert.equal(setEnvValues('A=1\n\n\n', { B: '2' }), 'A=1\nB=2\n');
});
