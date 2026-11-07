import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { childEnvironment } from '../src/tools/environment';

const SECRETS = ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'LEAFI_EMAIL_APP_PASSWORD'];

function withEnv(names: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map(Object.keys(names).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(names)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test('the child environment excludes host secrets', () => {
  withEnv(
    {
      OPENAI_API_KEY: 'sk-live',
      AWS_SECRET_ACCESS_KEY: 'aws-live',
      LEAFI_EMAIL_APP_PASSWORD: 'mail-live',
      PATH: '/usr/bin:/bin',
    },
    () => {
      const env = childEnvironment();
      assert.equal(env.PATH, '/usr/bin:/bin');
      for (const name of SECRETS) {
        assert.equal(env[name], undefined, `${name} must not be forwarded`);
      }
    },
  );
});

test('only names in AGENT_ENV_PASSTHROUGH are forwarded beyond the allowlist', () => {
  withEnv({ CUSTOM_TOKEN: 'custom', AGENT_ENV_PASSTHROUGH: 'CUSTOM_TOKEN' }, () => {
    const env = childEnvironment();
    assert.equal(env.CUSTOM_TOKEN, 'custom');
  });

  withEnv({ OTHER_TOKEN: 'other', AGENT_ENV_PASSTHROUGH: undefined }, () => {
    assert.equal(childEnvironment().OTHER_TOKEN, undefined);
  });
});

test('a home directory rewrites HOME and the temp directories', () => {
  const home = path.join('/tmp', 'leafi-env-test');
  const env = childEnvironment({ home });

  assert.equal(env.HOME, home);
  assert.equal(env.TMPDIR, path.join(home, 'tmp'));
  assert.equal(env.TMP, path.join(home, 'tmp'));
});
