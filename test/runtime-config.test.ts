import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeConfig } from '../src/config/runtime-config';

test('an unresolved env placeholder is not a provider key', () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '${OPENAI_API_KEY}';

  try {
    const config = new RuntimeConfig({ dataDir: '/tmp/leafi-runtime-config-test' });
    assert.equal(config.apiKeyFor('openai'), undefined);
    assert.ok(!config.availableProviders().some((provider) => provider.id === 'openai'));
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  }
});

test('a real provider key stays configured', () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-value';

  try {
    const config = new RuntimeConfig({ dataDir: '/tmp/leafi-runtime-config-test' });
    assert.equal(config.apiKeyFor('openai'), 'sk-test-value');
    assert.ok(config.availableProviders().some((provider) => provider.id === 'openai'));
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  }
});

test('time limits default to 2 minute commands, 10 minute asks, 30 minute jobs and 5 minute model calls', () => {
  const names = ['BASH_TIMEOUT_MS', 'BASH_TIMEOUT_MAX_MS', 'JOB_TIMEOUT_MS', 'MODEL_CALL_TIMEOUT_MS'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    delete process.env[name];
  }
  try {
    const config = new RuntimeConfig({ dataDir: '/tmp/graph-agents-runtime-config-test' });
    assert.equal(config.bashTimeoutMs, 120_000);
    assert.equal(config.bashTimeoutMaxMs, 600_000);
    assert.equal(config.jobTimeoutMs, 1_800_000);
    assert.equal(config.modelCallTimeoutMs, 300_000);

    // An older, longer BASH_TIMEOUT_MS raises the cap with it instead of being cut back.
    process.env.BASH_TIMEOUT_MS = '900000';
    assert.equal(new RuntimeConfig({ dataDir: '/tmp/graph-agents-runtime-config-test' }).bashTimeoutMaxMs, 900_000);
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
