import fs from 'node:fs/promises';
import path from 'node:path';
import { starterFlow } from '../app/starter-flow';
import { setEnvValues } from '../config/env-file';
import { ENV_TEMPLATE } from '../config/env-template';
import { resolveDataDir } from '../config/runtime-config';
import { askChoice, askSecret } from '../config/terminal-prompt';
import { PROVIDER_IDS, type ProviderId } from '../domain/types';
import { PROVIDER_CATALOG } from '../providers/provider-catalog';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../runtime/run-store';
import {
  assertFlags,
  assertNoPositionals,
  EXIT,
  GLOBAL_FLAGS,
  readBooleanFlag,
  readOptionalFlag,
  UsageError,
  type ExitCode,
  type ParsedArgs,
} from './args';

const DEFAULT_PROVIDER: ProviderId = 'anthropic';
const FLOW_FILE = 'flow.json';

type FileStatus = 'created' | 'updated' | 'kept';

/**
 * Creates the data directory, the settings file and a starter flow, so that
 * `run` works straight after a clone and build. The API key is asked for only in a
 * terminal, with the input hidden, so it never lands in shell history.
 */
export async function runInit(parsed: ParsedArgs): Promise<ExitCode> {
  assertFlags(parsed, [...GLOBAL_FLAGS, 'provider', 'yes', 'json']);
  assertNoPositionals(parsed);

  const interactive = !readBooleanFlag(parsed, 'yes') && process.stdin.isTTY === true && process.stderr.isTTY === true;
  const dataDir = resolveDataDir(readOptionalFlag(parsed, 'data-dir'));
  const envFlag = readOptionalFlag(parsed, 'env-file');
  const envFile = envFlag ? path.resolve(process.cwd(), envFlag) : path.join(dataDir, '.env');

  await fs.mkdir(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.chmod(dataDir, PRIVATE_DIR_MODE);

  const provider = await chooseProvider(parsed, interactive);
  const envKey = catalogEntry(provider).envKey;
  const keyInEnv = Boolean(process.env[envKey]?.trim());
  const typedKey = !keyInEnv && interactive ? await askSecret(`${envKey} (input hidden, Enter to skip): `) : '';
  const keyConfigured = keyInEnv || typedKey.length > 0;

  const envStatus = await writeEnvFile(envFile, envKey, typedKey);
  const flowPath = path.resolve(process.cwd(), FLOW_FILE);
  const flowStatus = await writeIfMissing(flowPath, `${JSON.stringify(starterFlow(provider), null, 2)}\n`);

  if (readBooleanFlag(parsed, 'json') || !process.stdout.isTTY) {
    process.stdout.write(
      `${JSON.stringify({ dataDir, envFile, envFileStatus: envStatus, provider, keyConfigured, flow: flowPath, flowStatus }, null, 2)}\n`,
    );
  }
  process.stderr.write(summary({ envFile, envStatus, envKey, keyConfigured, flowStatus, provider }));
  return EXIT.success;
}

async function chooseProvider(parsed: ParsedArgs, interactive: boolean): Promise<ProviderId> {
  const named = readOptionalFlag(parsed, 'provider');
  if (named !== undefined) {
    if (!(PROVIDER_IDS as readonly string[]).includes(named)) {
      throw new UsageError(`Unknown provider "${named}". Use one of: ${PROVIDER_IDS.join(', ')}.`);
    }
    return named as ProviderId;
  }

  const configured = PROVIDER_CATALOG.find((entry) => process.env[entry.envKey]?.trim());
  if (configured) {
    return configured.id;
  }
  if (!interactive) {
    return DEFAULT_PROVIDER;
  }

  const picked = PROVIDER_CATALOG[await askChoice('Which provider will you use?', PROVIDER_CATALOG.map((entry) => entry.label))];
  return picked?.id ?? DEFAULT_PROVIDER;
}

/** Writes the template once; afterwards only fills in a key the person just typed. */
async function writeEnvFile(file: string, envKey: string, key: string): Promise<FileStatus> {
  const existing = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (existing !== undefined && key.length === 0) {
    return 'kept';
  }

  const base = existing ?? ENV_TEMPLATE;
  const content = key.length === 0 ? base : setEnvValues(base, { [envKey]: key });

  await fs.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.writeFile(file, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await fs.chmod(file, PRIVATE_FILE_MODE);
  return existing === undefined ? 'created' : 'updated';
}

async function writeIfMissing(file: string, content: string): Promise<FileStatus> {
  try {
    await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'kept';
    }
    throw error;
  }
}

function catalogEntry(provider: ProviderId) {
  const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === provider);
  if (!entry) {
    throw new UsageError(`Unknown provider "${provider}".`);
  }
  return entry;
}

function summary(options: {
  envFile: string;
  envStatus: FileStatus;
  envKey: string;
  keyConfigured: boolean;
  flowStatus: FileStatus;
  provider: ProviderId;
}): string {
  const lines = [
    '',
    `Settings: ${options.envFile} (${options.envStatus === 'kept' ? 'already there, left as it was' : options.envStatus})`,
    options.flowStatus === 'created'
      ? `Starter flow: ${FLOW_FILE} (a research flow on ${options.provider})`
      : `Starter flow: ${FLOW_FILE} already exists, left as it was`,
    '',
  ];
  if (!options.keyConfigured) {
    lines.push(`Add your key to ${options.envFile} (${options.envKey}=...) or export it in your shell, then:`);
  } else {
    lines.push('Next:');
  }
  lines.push(
    `  leafi graph --graph ${FLOW_FILE}`,
    `  leafi run --graph ${FLOW_FILE} --input "What is known about small language models for code?"`,
    '',
  );
  return lines.join('\n');
}
