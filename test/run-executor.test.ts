import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FlowService } from '../src/app/flow-service';
import { RuntimeConfig } from '../src/config/runtime-config';
import { EmailService } from '../src/email/email-service';
import type { ModelFactory } from '../src/providers/model-factory';
import { RunExecutor } from '../src/runtime/run-executor';
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

const completeOnce = {
  content: '',
  tool_calls: [{ name: 'complete_task', args: { output: 'the answer' }, id: 'call-1' }],
  usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

function fakeModels(...responses: unknown[]): ModelFactory {
  const queue = responses.length > 0 ? [...responses] : [completeOnce];
  return {
    create: () => ({
      bindTools: () => ({ invoke: async () => queue.shift() ?? completeOnce }),
    }),
  } as unknown as ModelFactory;
}

test('a node runs to completion without a provider', async () => {
  const dir = makeTempDir('leafi-exec-');
  const config = new RuntimeConfig({ dataDir: dir });
  const store = new RunStore(config);
  const executor = new RunExecutor(config, store, fakeModels(), new EmailService(config));
  const graph = new FlowService().loadPayload({
    name: 'test',
    nodes: [{ id: 'a', label: 'A', provider: 'openai', model: 'gpt-4o-mini', prompt: 'answer' }],
    edges: [],
  });
  const run = store.createRun(graph, 'input', 'cli');

  const events: string[] = [];
  await executor.execute(graph, run, 'input', {
    save: true,
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(run.status, 'completed');
  assert.equal(run.outputs.a, 'the answer');
  assert.equal(run.personOutput, undefined);
  assert.equal(run.usage?.a?.total, 15);
  assert.ok(events.includes('node_started'));
  assert.ok(events.includes('run_completed'));
  assert.ok(fs.existsSync(store.eventsFile(run.id)));
});

test('a person-facing node is reported as the run deliverable', async () => {
  const dir = makeTempDir('leafi-exec-');
  const config = new RuntimeConfig({ dataDir: dir });
  const store = new RunStore(config);
  const executor = new RunExecutor(config, store, fakeModels(), new EmailService(config));
  const graph = new FlowService().loadPayload({
    name: 'test',
    nodes: [
      {
        id: 'a',
        label: 'A',
        provider: 'openai',
        model: 'gpt-4o-mini',
        prompt: 'answer',
        audience: 'person',
      },
    ],
    edges: [],
  });
  const run = store.createRun(graph, 'input', 'cli');

  await executor.execute(graph, run, 'input', { save: true });

  assert.deepEqual(run.personOutput, { nodeId: 'a', output: 'the answer' });
  const stored = await store.readRun(run.id);
  assert.deepEqual(stored?.personOutput, { nodeId: 'a', output: 'the answer' });
});

test('bash sees a filtered environment and a workspace home', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTempDir('leafi-exec-');
  const config = new RuntimeConfig({ dataDir: dir });
  const store = new RunStore(config);
  const secrets = { OPENAI_API_KEY: 'sk-live', AWS_SECRET_ACCESS_KEY: 'aws-live', LEAFI_EMAIL_APP_PASSWORD: 'mail-live' };
  const previous = new Map(Object.entries(secrets).map(([name]) => [name, process.env[name]]));
  Object.assign(process.env, secrets);

  const bashOnce = {
    content: '',
    tool_calls: [
      {
        name: 'run_bash',
        args: { command: 'env > env.txt; echo "$HOME" > home.txt; echo "$TMPDIR" > tmp.txt' },
        id: 'call-1',
      },
    ],
    usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const executor = new RunExecutor(config, store, fakeModels(bashOnce), new EmailService(config));
  const graph = new FlowService().loadPayload({
    name: 'test',
    nodes: [
      {
        id: 'a',
        label: 'A',
        provider: 'openai',
        model: 'gpt-4o-mini',
        prompt: 'inspect the environment',
        permissions: { bash: true },
      },
    ],
    edges: [],
  });
  const run = store.createRun(graph, 'input', 'cli');

  try {
    await executor.execute(graph, run, 'input', { save: true });
    const workspace = config.workspaceFor(run.id);
    const environment = fs.readFileSync(path.join(workspace, 'env.txt'), 'utf8');
    assert.equal(fs.readFileSync(path.join(workspace, 'home.txt'), 'utf8').trim(), workspace);
    assert.equal(fs.readFileSync(path.join(workspace, 'tmp.txt'), 'utf8').trim(), path.join(workspace, 'tmp'));
    for (const name of Object.keys(secrets)) {
      assert.ok(!environment.includes(`${name}=`), `${name} must not reach the shell`);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('a run reports billed and list-price cost per node, and names what it could not price', async () => {
  const dir = makeTempDir('leafi-exec-');
  const config = new RuntimeConfig({ dataDir: dir });
  const store = new RunStore(config);
  const billed = {
    ...completeOnce,
    response_metadata: { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0004 } },
  };
  const graph = new FlowService().loadPayload({
    name: 'test',
    nodes: [{ id: 'a', label: 'A', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', prompt: 'answer' }],
    edges: [],
  });

  const run = store.createRun(graph, 'input', 'cli');
  await new RunExecutor(config, store, fakeModels(billed), new EmailService(config)).execute(graph, run, 'input', {
    save: false,
  });
  assert.equal(run.costUsd, 0.0004);
  assert.equal(run.usage?.a?.costSource, 'billed');
  assert.equal(run.pricesAsOf, undefined);

  // The same model with no reported cost cannot be priced from the table.
  const unpriced = store.createRun(graph, 'input', 'cli');
  await new RunExecutor(config, store, fakeModels(), new EmailService(config)).execute(graph, unpriced, 'input', {
    save: false,
  });
  assert.equal(unpriced.costUsd, undefined);
  assert.deepEqual(unpriced.unpricedModels, ['deepseek/deepseek-v4.1-flash']);
});

test('a direct-provider run is priced at list price and dated', async () => {
  const dir = makeTempDir('leafi-exec-');
  const config = new RuntimeConfig({ dataDir: dir });
  const store = new RunStore(config);
  const graph = new FlowService().loadPayload({
    name: 'test',
    nodes: [{ id: 'a', label: 'A', provider: 'openai', model: 'gpt-4o-mini', prompt: 'answer' }],
    edges: [],
  });
  const run = store.createRun(graph, 'input', 'cli');
  await new RunExecutor(config, store, fakeModels(), new EmailService(config)).execute(graph, run, 'input', {
    save: false,
  });

  assert.equal(run.usage?.a?.costSource, 'list-price');
  assert.ok(Math.abs((run.costUsd ?? 0) - (10 * 0.15 + 5 * 0.6) / 1_000_000) < 1e-15);
  assert.match(run.pricesAsOf ?? '', /^\d{4}-\d{2}-\d{2}$/);
});

test('a node that runs out of calls hands over a partial result, and its successor is told', async () => {
  const dir = makeTempDir('leafi-exec-');
  const config = new RuntimeConfig({ dataDir: dir });
  const store = new RunStore(config);
  const inputs: string[] = [];
  const queue: unknown[] = [
    { content: '', tool_calls: [{ name: 'run_bash', args: { command: 'true' }, id: 't1' }], usage_metadata: completeOnce.usage_metadata },
    { content: 'Scored 40 of 145; the rest are unscored.', usage_metadata: completeOnce.usage_metadata },
  ];
  const models = {
    create: () => ({
      bindTools: () => ({
        invoke: async (messages: { content: unknown }[]) => {
          inputs.push(String(messages[1]?.content ?? ''));
          return queue.shift() ?? completeOnce;
        },
      }),
    }),
  } as unknown as ModelFactory;
  const graph = new FlowService().loadPayload({
    name: 'test',
    nodes: [
      { id: 'a', label: 'Score', provider: 'openai', model: 'gpt-4o-mini', prompt: 'score', maxIterations: 2 },
      { id: 'b', label: 'Report', provider: 'openai', model: 'gpt-4o-mini', prompt: 'report' },
    ],
    edges: [{ source: 'a', target: 'b' }],
  });
  const run = store.createRun(graph, 'input', 'cli');
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  await new RunExecutor(config, store, models, new EmailService(config)).execute(graph, run, 'input', {
    save: false,
    onEvent: (event) => events.push(event),
  });

  assert.equal(run.status, 'completed');
  assert.deepEqual(run.stoppedEarlyNodes, ['a']);
  assert.equal(run.outputs.a, 'Scored 40 of 145; the rest are unscored.');
  assert.equal(run.usage?.a?.iterations, 2);
  assert.match(inputs.at(-1) ?? '', /## Score\n\n\(This node ran out of model calls before finishing, so its output below is partial/);
  assert.equal(events.filter((event) => event.type === 'model_call').length, 3);
  assert.equal(events.find((event) => event.type === 'node_completed')?.payload.stoppedEarly, true);
});

test('maxIterations must be a whole number of calls', () => {
  const flow = (maxIterations: unknown) => ({
    name: 'test',
    nodes: [{ id: 'a', label: 'A', provider: 'openai', model: 'gpt-4o-mini', prompt: 'p', maxIterations }],
    edges: [],
  });
  assert.equal(new FlowService().loadPayload(flow(40)).nodes[0]?.maxIterations, 40);
  assert.throws(() => new FlowService().loadPayload(flow(0)), /maxIterations must be a whole number/);
  assert.throws(() => new FlowService().loadPayload(flow(2.5)), /maxIterations must be a whole number/);
});
