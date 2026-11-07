import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { changePermissions, parsePermissionList } from '../src/mcp/settings';

const CLI = path.resolve('dist/main.js');
const MCP = path.resolve('dist/mcp/main.js');
const tempDirs: string[] = [];

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-settings-'));
  tempDirs.push(dir);
  return dir;
}

/** An existing settings file: Node 22 rejects a missing `--env-file` path before the CLI starts. */
function envFile(content: string): string {
  const file = path.join(tempDir(), '.env');
  fs.writeFileSync(file, content);
  return file;
}

/** A Hermes home of its own, so no test can reach the real `~/.hermes`. */
function hermesHome(withPlugin: boolean): string {
  const home = path.join(tempDir(), 'hermes');
  fs.mkdirSync(withPlugin ? path.join(home, 'plugins', 'leafi') : home, { recursive: true });
  return home;
}

function settings(bin: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [bin, 'settings', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: hermesHome(false), ...env },
    input: '',
  });
}

test('settings --allow writes only the lines it changes and keeps every other line', () => {
  const file = envFile('# Hermes\nHERMES_MODEL=nous/hermes\nLEAFI_ALLOW_WEB=true\n');
  const result = settings(CLI, ['--env-file', file, '--allow', 'web,bash']);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout).files[0];
  assert.deepEqual(report.saved, ['LEAFI_ALLOW_BASH=true']);
  assert.equal(report.permissions.bash, true);
  assert.equal(report.permissions.write, false);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '# Hermes\nHERMES_MODEL=nous/hermes\nLEAFI_ALLOW_WEB=true\n\n# leafi permissions\nLEAFI_ALLOW_BASH=true\n',
  );
  assert.match(result.stderr, /start a new Hermes session/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('settings --deny wins over --allow, so "--allow all --deny bash" allows everything but bash', () => {
  const file = envFile('LEAFI_ALLOW_BASH=true\n');
  const result = settings(CLI, ['--env-file', file, '--allow', 'all', '--deny', 'bash']);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout).files[0];
  assert.deepEqual(report.permissions, { web: true, write: true, bash: false, email: true, mcp: true, 'flow-paths': true });
  // Flow paths are allowed when unset, so no line is written for them.
  assert.deepEqual(report.saved, [
    'LEAFI_ALLOW_WEB=true',
    'LEAFI_ALLOW_WRITE=true',
    'LEAFI_ALLOW_BASH=false',
    'LEAFI_ALLOW_EMAIL=true',
    'LEAFI_ALLOW_MCP=true',
  ]);
  assert.equal(report.mailboxMissing, true);
  assert.match(result.stderr, /Email is allowed, but .* has no LEAFI_EMAIL_ADDRESS/);
});

test('settings off a terminal with no flags prints the permissions and writes nothing', () => {
  const original = 'LEAFI_ALLOW_WEB=yes\nLEAFI_ALLOW_FLOW_PATHS=false\n';
  const file = envFile(original);
  const result = settings(CLI, ['--env-file', file]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).files[0].permissions, {
    web: true,
    write: false,
    bash: false,
    email: false,
    mcp: false,
    'flow-paths': false,
  });
  assert.match(result.stderr, /web {9}allowed/);
  assert.match(result.stderr, /bash {8}denied/);
  assert.match(result.stderr, /--allow and --deny/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('settings rejects an unknown permission with exit 3 and changes nothing', () => {
  const file = envFile('LEAFI_ALLOW_WEB=true\n');
  const result = settings(CLI, ['--env-file', file, '--deny', 'web,shell']);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /Unknown permission "shell"/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'LEAFI_ALLOW_WEB=true\n');
});

test("settings changes Hermes's file when the plugin is installed there, and says so", () => {
  const home = hermesHome(true);
  const dataDir = path.join(tempDir(), 'home');
  const result = settings(CLI, ['--data-dir', dataDir, '--allow', 'web'], { HERMES_HOME: home });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), '# leafi permissions\nLEAFI_ALLOW_WEB=true\n');
  assert.equal(fs.existsSync(path.join(dataDir, '.env')), false);
});

test("settings changes the data directory's file when Hermes has no plugin", () => {
  const home = hermesHome(false);
  const dataDir = path.join(tempDir(), 'home');
  const result = settings(CLI, ['--data-dir', dataDir], { HERMES_HOME: home });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\(read by the leafi command and the MCP server for your other clients\)/);

  const changed = settings(CLI, ['--data-dir', dataDir, '--allow', 'write'], { HERMES_HOME: home });
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(fs.readFileSync(path.join(dataDir, '.env'), 'utf8'), '# leafi permissions\nLEAFI_ALLOW_WRITE=true\n');
  assert.equal(fs.existsSync(path.join(home, '.env')), false);
});

test('the MCP server\'s settings picks the same file', () => {
  const home = hermesHome(true);
  const result = settings(MCP, ['--allow', 'bash', '--deny', 'flow-paths'], { HERMES_HOME: home });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).files[0].saved, ['LEAFI_ALLOW_BASH=true', 'LEAFI_ALLOW_FLOW_PATHS=false']);
  assert.equal(
    fs.readFileSync(path.join(home, '.env'), 'utf8'),
    '# leafi permissions\nLEAFI_ALLOW_BASH=true\nLEAFI_ALLOW_FLOW_PATHS=false\n',
  );
});

test('with the Hermes plugin and another client both set up, settings changes both files', () => {
  const home = hermesHome(true);
  const dataDir = path.join(tempDir(), 'home');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, '.env'), 'LEAFI_ALLOW_BASH=true\n');

  const shown = settings(CLI, ['--data-dir', dataDir], { HERMES_HOME: home });
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout).files.map((file: { permissions: { bash: boolean } }) => file.permissions.bash), [false, true]);
  assert.match(shown.stderr, /read by the Hermes plugin[\s\S]*read by the leafi command and the MCP server for your other clients/);

  const changed = settings(CLI, ['--data-dir', dataDir, '--allow', 'web', '--deny', 'bash'], { HERMES_HOME: home });
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), '# leafi permissions\nLEAFI_ALLOW_WEB=true\n');
  assert.equal(
    fs.readFileSync(path.join(dataDir, '.env'), 'utf8'),
    'LEAFI_ALLOW_BASH=false\n\n# leafi permissions\nLEAFI_ALLOW_WEB=true\n',
  );
});

test('settings no longer takes --hermes', () => {
  assert.equal(settings(CLI, ['--hermes']).status, 3);
});

test('the settings checklist starts from what the server reads now, not ticked like init', async () => {
  const file = envFile('LEAFI_ALLOW_EMAIL=true\n');
  let offered: Record<string, boolean> = {};

  const [result] = await changePermissions([{ envFile: file, hermes: false }], async (reads) => {
    offered = Object.fromEntries(reads[0] ?? []);
    return reads;
  });

  assert.deepEqual(offered, {
    LEAFI_ALLOW_WEB: false,
    LEAFI_ALLOW_WRITE: false,
    LEAFI_ALLOW_BASH: false,
    LEAFI_ALLOW_EMAIL: true,
    LEAFI_ALLOW_MCP: false,
    LEAFI_ALLOW_FLOW_PATHS: true,
  });
  assert.deepEqual(result?.saved, []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'LEAFI_ALLOW_EMAIL=true\n');
});

test('permission lists take ids in any case, spaces, or all', () => {
  assert.deepEqual(parsePermissionList('--allow', 'Web, BASH'), ['LEAFI_ALLOW_WEB', 'LEAFI_ALLOW_BASH']);
  assert.equal(parsePermissionList('--deny', 'all').length, 6);
  assert.throws(() => parsePermissionList('--allow', ' , '), /needs at least one permission/);
});
