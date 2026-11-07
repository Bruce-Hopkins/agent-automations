import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adoptLegacyEnv, currentEnvName, renameLegacyEnvKeys } from '../src/config/legacy-names';
import { resolveDataDir } from '../src/config/runtime-config';
import { changePermissions } from '../src/mcp/settings';

const CLI = path.resolve('dist/main.js');
const tempDirs: string[] = [];

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-legacy-'));
  tempDirs.push(dir);
  return dir;
}

function withEnv<T>(names: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(Object.keys(names).map((name) => [name, process.env[name]]));
  const set = (entries: Iterable<[string, string | undefined]>) => {
    for (const [name, value] of entries) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  set(Object.entries(names));
  try {
    return run();
  } finally {
    set(previous);
  }
}

test('an old setting name is mapped to its new one, and nothing else is', () => {
  assert.equal(currentEnvName('AGENTS_AUTOMATIONS_ALLOW_BASH'), 'LEAFI_ALLOW_BASH');
  assert.equal(currentEnvName('OPENAI_API_KEY'), undefined);
});

test('an old variable is read under its new name, with one warning, and a new one always wins', () => {
  withEnv(
    {
      AGENTS_AUTOMATIONS_MCP_TOOLS: 'take_snapshot',
      LEAFI_MCP_TOOLS: undefined,
      AGENTS_AUTOMATIONS_ALLOW_BASH: 'true',
      LEAFI_ALLOW_BASH: 'false',
      AGENTS_AUTOMATIONS_EMAIL_ADDRESS: '${AGENTS_AUTOMATIONS_EMAIL_ADDRESS}',
      LEAFI_EMAIL_ADDRESS: undefined,
    },
    () => {
      const warnings: string[] = [];
      const adopted = adoptLegacyEnv((text) => warnings.push(text));

      assert.deepEqual(adopted, ['AGENTS_AUTOMATIONS_MCP_TOOLS']);
      assert.equal(process.env.LEAFI_MCP_TOOLS, 'take_snapshot');
      assert.equal(process.env.LEAFI_ALLOW_BASH, 'false', 'a value set under the new name is kept');
      assert.equal(process.env.LEAFI_EMAIL_ADDRESS, undefined, 'an unexpanded placeholder is not copied');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /AGENTS_AUTOMATIONS_MCP_TOOLS → LEAFI_MCP_TOOLS/);

      delete process.env.LEAFI_MCP_TOOLS;
      adoptLegacyEnv((text) => warnings.push(text));
      assert.equal(warnings.length, 1, 'a name is warned about once per process');
    },
  );
});

test('old names in a settings file are renamed in place, keeping values, comments and order', () => {
  const before = [
    '# my settings',
    'OPENAI_API_KEY=sk-test',
    'AGENTS_AUTOMATIONS_ALLOW_BASH=true',
    'export AGENTS_AUTOMATIONS_EMAIL_ADDRESS = me@example.com',
    'AGENTS_AUTOMATIONS_ALLOW_WEB=true',
    'LEAFI_ALLOW_WEB=false',
    '# AGENTS_AUTOMATIONS_ALLOW_MCP=false',
    '',
  ].join('\n');
  assert.equal(
    renameLegacyEnvKeys(before),
    [
      '# my settings',
      'OPENAI_API_KEY=sk-test',
      'LEAFI_ALLOW_BASH=true',
      'export LEAFI_EMAIL_ADDRESS = me@example.com',
      'AGENTS_AUTOMATIONS_ALLOW_WEB=true',
      'LEAFI_ALLOW_WEB=false',
      '# AGENTS_AUTOMATIONS_ALLOW_MCP=false',
      '',
    ].join('\n'),
  );
});

test('settings reads permissions saved under old names and saves them under the new ones', async () => {
  const file = path.join(tempDir(), '.env');
  fs.writeFileSync(file, 'AGENTS_AUTOMATIONS_ALLOW_BASH=true\n');

  const [result] = await changePermissions([{ envFile: file, hermes: false }], async (reads) => reads);

  assert.equal(result!.permissions.bash, true, 'the old value is what the server reads');
  assert.equal(fs.readFileSync(file, 'utf8'), 'LEAFI_ALLOW_BASH=true\n');
});

test('the data folder from before the rename is used until ~/.leafi exists, unless it is empty', () => {
  const home = tempDir();
  withEnv({ HOME: home, USERPROFILE: home, DATA_DIR: undefined, LEAFI_HOME: undefined }, () => {
    const legacy = path.join(home, '.agents-automations');
    fs.mkdirSync(legacy);
    assert.equal(resolveDataDir(), path.join(home, '.leafi'), 'an empty old folder is ignored');

    fs.writeFileSync(path.join(legacy, '.env'), 'OPENAI_API_KEY=sk-test\n');
    assert.equal(resolveDataDir(), legacy);

    fs.mkdirSync(path.join(home, '.leafi'));
    assert.equal(resolveDataDir(), path.join(home, '.leafi'));
  });
});

test('the CLI finds its settings through the old home variable and says to rename it', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, '.env'), 'AGENTS_AUTOMATIONS_ALLOW_WEB=true\n');
  const result = spawnSync(process.execPath, [CLI, 'settings', '--json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: tempDir(), HERMES_HOME: tempDir(), AGENTS_AUTOMATIONS_HOME: dataDir },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /AGENTS_AUTOMATIONS_HOME → LEAFI_HOME/);
  const { files } = JSON.parse(result.stdout) as { files: { envFile: string; permissions: Record<string, boolean> }[] };
  assert.equal(files[0]!.envFile, path.join(dataDir, '.env'));
  assert.equal(files[0]!.permissions.web, true);
  assert.equal(fs.readFileSync(path.join(dataDir, '.env'), 'utf8'), 'LEAFI_ALLOW_WEB=true\n', 'the file is saved under the new name');
});
