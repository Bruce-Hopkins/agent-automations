import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDirs: string[] = [];

/** A fresh temp directory, removed when this file's tests finish. */
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CLI = path.resolve('dist/main.js');

function run(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: options.env ?? process.env,
  });
}

function tempDir(): string {
  return makeTempDir('leafi-test-');
}

test('schema example validates with exit 0', () => {
  const schema = run(['schema', 'example']);
  assert.equal(schema.status, 0);
  const dir = tempDir();
  const flow = path.join(dir, 'flow.json');
  fs.writeFileSync(flow, schema.stdout);
  const validation = run(['validate', '--graph', flow, '--data-dir', dir]);
  assert.equal(validation.status, 0);
  const body = JSON.parse(validation.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.estimate, undefined);
  assert.match(body.minimum.note, /lower bound, not a forecast/);
  assert.ok(body.minimum.totalTokens > 0);
  // Dollars are reported after a run, from what it used; the minimum counts tokens only.
  assert.equal(body.minimum.totalCostUsd, undefined);
  assert.equal(body.minimum.nodes[0].costUsd, undefined);
});

test('malformed JSON exits 2', () => {
  const dir = tempDir();
  const flow = path.join(dir, 'bad.json');
  fs.writeFileSync(flow, 'not json');
  assert.equal(run(['validate', '--graph', flow]).status, 2);
});

test('missing --graph exits 3', () => {
  assert.equal(run(['run', '--events', 'none']).status, 3);
});

test('unknown flag exits 3', () => {
  assert.equal(run(['validate', '--graph', '-', '--nope']).status, 3);
});

test('a run without provider keys exits 4', () => {
  const dir = tempDir();
  const example = run(['schema', 'example']).stdout;
  const flow = path.join(dir, 'flow.json');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(flow, example);
  fs.writeFileSync(envFile, '');
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) {
    delete env[key];
  }
  const result = run(['run', '--graph', flow, '--events', 'none', '--no-save', '--env-file', envFile, '--data-dir', dir], {
    env,
  });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /No API key/);
});

test('runs list starts empty', () => {
  const dir = tempDir();
  const result = run(['runs', 'list', '--data-dir', dir]);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('graph renders without needing credentials', () => {
  const dir = tempDir();
  const flow = path.join(dir, 'flow.json');
  fs.writeFileSync(flow, run(['schema', 'example']).stdout);
  const result = run(['graph', '--graph', flow]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Planner/);
});
