import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RuntimeConfig } from '../src/config/runtime-config';
import { RunStore } from '../src/runtime/run-store';

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

function storeAt(dataDir: string): RunStore {
  return new RunStore(new RuntimeConfig({ dataDir }));
}

function tempRoot(): string {
  return makeTempDir('leafi-store-test-');
}

test('a run id cannot read outside the runs directory', async () => {
  const root = tempRoot();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(root, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside', 'meta.json'), '{"id":"outside"}');

  const store = storeAt(dataDir);
  assert.equal(await store.readRun('../outside'), null);
  assert.equal(await store.readRun(path.join(root, 'outside')), null);
  assert.equal(await store.readRun(''), null);
  assert.deepEqual(await store.readEvents('../outside'), []);
});

test('a run id cannot create a workspace outside the workspaces directory', async () => {
  const root = tempRoot();
  const dataDir = path.join(root, 'data');
  const store = storeAt(dataDir);

  await assert.rejects(store.createRunWorkspace('../escape'), /Invalid run id/);
  await assert.throws(() => store.eventsFile('../escape'), /Invalid run id/);
  assert.equal(fs.existsSync(path.join(root, 'escape')), false);
});

test('a generated run round-trips through its own directory', async () => {
  const dataDir = path.join(tempRoot(), 'data');
  const store = storeAt(dataDir);
  const now = new Date().toISOString();
  const graph = { id: 'g', name: 'g', nodes: [], edges: [], createdAt: now, updatedAt: now };
  const run = store.createRun(graph, 'input', 'cli');

  await store.writeRun(run);
  assert.deepEqual(await store.readRun(run.id), run);

  const workspace = await store.createRunWorkspace(run.id);
  assert.ok(workspace.startsWith(path.join(dataDir, 'workspaces')));
  assert.ok(fs.existsSync(workspace));
});
