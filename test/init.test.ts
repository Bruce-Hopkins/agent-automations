import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENV_TEMPLATE } from '../src/config/env-template';

const tempDirs: string[] = [];

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CLI = path.resolve('dist/main.js');
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];

/** A temp folder to run in, holding its own data directory under `home/`. */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-init-'));
  tempDirs.push(dir);
  return dir;
}

function init(cwd: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  for (const name of PROVIDER_KEYS) {
    if (!(name in extraEnv)) {
      delete env[name];
    }
  }
  return spawnSync(process.execPath, [CLI, 'init', '--data-dir', path.join(cwd, 'home'), ...args], {
    encoding: 'utf8',
    cwd,
    env,
    input: '',
  });
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

test('init creates an owner-only data dir, settings file and a valid starter flow', () => {
  const dir = tempDir();
  const result = init(dir);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.provider, 'anthropic');
  assert.equal(report.keyConfigured, false);
  assert.equal(report.envFileStatus, 'created');
  assert.equal(report.flowStatus, 'created');
  assert.match(result.stderr, /ANTHROPIC_API_KEY=\.\.\./);

  if (process.platform !== 'win32') {
    assert.equal(mode(path.join(dir, 'home')), 0o700);
    assert.equal(mode(path.join(dir, 'home', '.env')), 0o600);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'home', '.env'), 'utf8'), ENV_TEMPLATE);

  const validation = spawnSync(process.execPath, [CLI, 'validate', '--strict', '--graph', 'flow.json', '--data-dir', path.join(dir, 'home')], {
    encoding: 'utf8',
    cwd: dir,
  });
  assert.equal(validation.status, 0, validation.stdout);
});

test('init picks the provider whose key is already set and never copies the key', () => {
  const dir = tempDir();
  const result = init(dir, [], { OPENAI_API_KEY: 'sk-from-shell' });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.provider, 'openai');
  assert.equal(report.keyConfigured, true);
  const flow = JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'));
  assert.ok(flow.nodes.every((node: { provider: string }) => node.provider === 'openai'));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'home', '.env'), 'utf8'), /sk-from-shell/);
});

test('init leaves an existing settings file and flow.json untouched', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(dir, 'home', '.env'), 'GOOGLE_API_KEY=mine\n');
  fs.writeFileSync(path.join(dir, 'flow.json'), '{"mine":true}\n');

  const result = init(dir, ['--provider', 'openai']);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.envFileStatus, 'kept');
  assert.equal(report.flowStatus, 'kept');
  assert.equal(fs.readFileSync(path.join(dir, 'home', '.env'), 'utf8'), 'GOOGLE_API_KEY=mine\n');
  assert.equal(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8'), '{"mine":true}\n');
});

test('init rejects an unknown provider with exit 3', () => {
  assert.equal(init(tempDir(), ['--provider', 'nope']).status, 3);
});

test('the CLI init no longer takes --hermes or --plugin-source: the installer sets up agents', () => {
  assert.equal(init(tempDir(), ['--hermes']).status, 3);
  assert.equal(init(tempDir(), ['--plugin-source', 'owner/repo/hermes-plugin']).status, 3);
});

test('the init template names the same settings as .env.example', () => {
  const names = (text: string) =>
    [...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]).sort();
  assert.deepEqual(names(ENV_TEMPLATE), names(fs.readFileSync('.env.example', 'utf8')));
});
