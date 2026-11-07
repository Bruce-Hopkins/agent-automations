import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentNode } from '../src/domain/types';
import { createNodeToolkit } from '../src/tools/node-toolkit';
import { pieceEnd, ToolOutput } from '../src/tools/tool-output';
import { Workspace } from '../src/tools/workspace';

const POSIX = process.platform !== 'win32';
const LIMIT = 100;
const SAVE_LIMIT = 1000;
const roots: string[] = [];

test.after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function workspace(): Promise<Workspace> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-output-test-'));
  roots.push(root);
  return Workspace.open(root);
}

function node(permissions: Partial<AgentNode['permissions']>, id = 'n'): AgentNode {
  return {
    id,
    label: 'Node',
    provider: 'openai',
    model: 'test-model',
    prompt: 'test',
    position: { x: 0, y: 0 },
    permissions: { read: false, write: false, bash: false, web: false, email_read: false, mcp: false, ...permissions },
  };
}

async function toolkitFor(permissions: Partial<AgentNode['permissions']>, id = 'n') {
  const ws = await workspace();
  const toolkit = createNodeToolkit({
    node: node(permissions, id),
    workspace: ws,
    limits: { bashTimeoutMs: 10_000, outputLimitBytes: LIMIT, outputSaveLimitBytes: SAVE_LIMIT, webFetchTimeoutMs: 5000, webFetchLimitBytes: 65536 },
    signal: new AbortController().signal,
  });
  return { toolkit, root: ws.root };
}

/** Follows the "continue with offset=N" notes until the end of the file. */
async function readAll(toolkit: Awaited<ReturnType<typeof toolkitFor>>['toolkit'], file: string): Promise<string> {
  let offset = 0;
  let text = '';
  for (let calls = 0; calls < 1000; calls += 1) {
    const piece = await toolkit.execute('read_file', { path: file, offset });
    const note = /^\[[^\]]*: bytes (\d+)-(\d+) of (\d+); (?:continue with offset=(\d+)|end of file)\]\n/.exec(piece);
    if (!note) {
      return text + piece;
    }
    text += piece.slice(note[0].length);
    if (!note[4]) {
      return text;
    }
    offset = Number(note[4]);
  }
  throw new Error('read_file never reached the end of the file');
}

test('read_file returns a file that fits unchanged, with no note', async () => {
  const { toolkit, root } = await toolkitFor({ read: true });
  fs.writeFileSync(path.join(root, 'small.txt'), 'hello\n');
  assert.equal(await toolkit.execute('read_file', { path: 'small.txt' }), 'hello\n');
});

test('read_file pages through a long file and loses nothing', async () => {
  const { toolkit, root } = await toolkitFor({ read: true });
  const content = Array.from({ length: 60 }, (_, index) => `line ${index} ${'é'.repeat(index % 7)}`).join('\n');
  fs.writeFileSync(path.join(root, 'long.txt'), content);

  const first = await toolkit.execute('read_file', { path: 'long.txt' });
  assert.match(first, /^\[long\.txt: bytes 0-\d+ of \d+; continue with offset=\d+\]\n/);
  assert.ok(Buffer.byteLength(first.slice(first.indexOf(']\n') + 2)) <= LIMIT);
  assert.equal(await readAll(toolkit, 'long.txt'), content);
});

test('read_file never splits a multi-byte character, whatever the offset', async () => {
  const { toolkit, root } = await toolkitFor({ read: true });
  const content = '€'.repeat(80);
  fs.writeFileSync(path.join(root, 'euro.txt'), content);

  // Offset 1 lands inside the first three-byte character.
  const piece = await toolkit.execute('read_file', { path: 'euro.txt', offset: 1, length: 10 });
  assert.match(piece, /^\[euro\.txt: bytes 3-12 of 240; continue with offset=12\]\n€€€$/);
  assert.equal(await readAll(toolkit, 'euro.txt'), content);
});

test('read_file caps length at the budget and reports an offset past the end', async () => {
  const { toolkit, root } = await toolkitFor({ read: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(500));

  const piece = await toolkit.execute('read_file', { path: 'a.txt', length: 10_000 });
  assert.match(piece, /^\[a\.txt: bytes 0-100 of 500; continue with offset=100\]\n/);
  assert.match(await toolkit.execute('read_file', { path: 'a.txt', offset: 500 }), /past the end/);
  assert.match(await toolkit.execute('read_file', { path: 'a.txt', offset: -1 }), /^Error: "offset" must be a whole number/);
});

test('an oversized run_bash result is saved whole and the note says how to read on', { skip: !POSIX }, async () => {
  const { toolkit, root } = await toolkitFor({ read: true, bash: true }, 'find papers');
  const result = await toolkit.execute('run_bash', { command: 'seq 1 200' });

  const note = /^Exit code: 0\n\[showing the first (\d+) and the last \d+ of (\d+) bytes; the full output is saved to (\S+); continue with read_file path="\3" offset=\1\]\n/.exec(result);
  assert.ok(note, result);
  // The end of the output is shown too, because errors come last.
  assert.match(result, /\n\[…\]\n(?:.*\n)*200$/);
  assert.equal(note[3], '.tool-output/find_papers-run_bash-1.txt');
  const saved = fs.readFileSync(path.join(root, note[3]!), 'utf8');
  assert.equal(saved, Array.from({ length: 200 }, (_, index) => index + 1).join('\n'));
  assert.equal(Buffer.byteLength(saved), Number(note[2]));
});

test('a node with bash but no read is told to read on with tail and head', { skip: !POSIX }, async () => {
  const { toolkit } = await toolkitFor({ bash: true });
  const result = await toolkit.execute('run_bash', { command: 'seq 1 200' });
  assert.match(result, /continue with: tail -c \+\d+ \.tool-output\/n-run_bash-1\.txt \| head -c 100\]\n/);
});

test('run_bash stops collecting at the save limit and says the rest was lost', { skip: !POSIX }, async () => {
  const { toolkit, root } = await toolkitFor({ read: true, bash: true });
  const result = await toolkit.execute('run_bash', { command: 'yes | head -c 5000' });

  assert.match(result, new RegExp(`of more than ${SAVE_LIMIT} bytes; the first ${SAVE_LIMIT} bytes are saved to`));
  assert.equal(fs.statSync(path.join(root, '.tool-output', 'n-run_bash-1.txt')).size, SAVE_LIMIT);
});

test('run_bash shows the true end of the output even past the save limit', { skip: !POSIX }, async () => {
  const { toolkit } = await toolkitFor({ read: true, bash: true });
  // 3000 lines of filler, then the line that matters: it arrives long after collection stopped.
  const result = await toolkit.execute('run_bash', { command: 'yes filler | head -n 3000; echo "FAILED: test_login"' });

  assert.match(result, /\n\[…\]\n/);
  assert.match(result, /FAILED: test_login$/);
});

test('a node that cannot read a saved file gets no file, only a note', async () => {
  const ws = await workspace();
  const output = new ToolOutput({ workspace: ws, nodeId: 'n', limitBytes: LIMIT, saveLimitBytes: SAVE_LIMIT });
  const result = await output.cap('web_fetch', 'y'.repeat(300));

  assert.match(result, /^\[showing the first 100 of 300 bytes; the rest was not kept\]\ny{100}$/);
  assert.equal(fs.existsSync(path.join(ws.root, '.tool-output')), false);
  assert.match(output.describe(), /the rest is not kept/);
});

test('saved files are numbered per call and named per node, so parallel nodes never collide', async () => {
  const ws = await workspace();
  const a = new ToolOutput({ workspace: ws, nodeId: 'a', limitBytes: LIMIT, saveLimitBytes: SAVE_LIMIT, reader: 'read_file' });
  const b = new ToolOutput({ workspace: ws, nodeId: 'b', limitBytes: LIMIT, saveLimitBytes: SAVE_LIMIT, reader: 'read_file' });
  const big = 'z'.repeat(300);

  await Promise.all([a.cap('web_fetch', big), a.cap('web_fetch', big), b.cap('web_fetch', big)]);
  assert.deepEqual(fs.readdirSync(path.join(ws.root, '.tool-output')).sort(), [
    'a-web_fetch-1.txt',
    'a-web_fetch-2.txt',
    'b-web_fetch-1.txt',
  ]);
});

test('a short preview, as email uses, is honoured below the budget', async () => {
  const ws = await workspace();
  const output = new ToolOutput({ workspace: ws, nodeId: 'n', limitBytes: LIMIT, saveLimitBytes: SAVE_LIMIT, reader: 'read_file' });
  const result = await output.cap('email_get_message', 'm'.repeat(80), { previewBytes: 40 });
  assert.match(result, /^\[showing the first 40 of 80 bytes; the full output is saved to[^\]]*\]\nm{40}$/);
});

test('tool descriptions state the budget the node actually has', async () => {
  const { toolkit } = await toolkitFor({ read: true, bash: true });
  const descriptions = toolkit.schemas.map((schema) => schema.description).join('\n');
  assert.match(descriptions, /at most 100 bytes per call/);
  assert.match(descriptions, /with a note at the top saying so/);
  assert.match(descriptions, /up to 1000 bytes, is saved to a file in \.tool-output\/ that you can read on from with read_file and offset/);
});

test('pieceEnd prefers a line break in the second half, and always advances', () => {
  const lines = Buffer.from('aaaa\nbbbbbbbbbb');
  assert.equal(pieceEnd(lines, 0, 8), 5);
  assert.equal(pieceEnd(Buffer.from('€€'), 0, 1), 3);
});
