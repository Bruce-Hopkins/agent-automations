import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { adoptLegacyEnv } from './legacy-names';
import { readBoolean, resolveDataDir } from './runtime-config';

export interface EnvOptions {
  /** A path chosen with `--env-file`; relative paths resolve against the cwd. */
  envFile?: string;
  /** `--data-dir`, which also decides where the default env file lives. */
  dataDir?: string;
}

/**
 * Loads the env file once, before anything reads process.env. The default is
 * `<data dir>/.env`, never the current directory: a downloaded project's `.env`
 * could otherwise redirect provider traffic or choose the MCP server launcher.
 */
export function loadEnvironment(options: EnvOptions = {}): string {
  // Twice: the old home variable decides where the file is, and the file may
  // still use old names itself.
  adoptLegacyEnv();
  const file = options.envFile
    ? path.resolve(process.cwd(), options.envFile)
    : path.join(resolveDataDir(options.dataDir), '.env');
  loadDotenv({ path: file, quiet: true });
  adoptLegacyEnv();
  return file;
}

/** The one setting that lets LangSmith tracing variables take effect. */
export const TRACING_OPT_IN = 'LEAFI_LANGSMITH_TRACING';

/** Every variable that turns on LangChain/LangSmith tracing, which uploads prompts and tool results. */
const TRACING_SWITCHES = [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
  'LANGCHAIN_TRACING',
  'LANGSMITH_OTEL_ENABLED',
];

/**
 * Removes the tracing switches unless the person opted in with
 * `LEAFI_LANGSMITH_TRACING=true`. A run's prompts include web pages and
 * email excerpts, so they leave the machine only on purpose.
 */
export function disableImplicitTracing(): void {
  if (readBoolean(TRACING_OPT_IN, false)) {
    return;
  }
  for (const name of TRACING_SWITCHES) {
    delete process.env[name];
  }
}
