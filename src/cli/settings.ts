import path from 'node:path';
import { runSettings, settingsFiles } from '../mcp/settings';
import {
  assertFlags,
  assertNoPositionals,
  EXIT,
  GLOBAL_FLAGS,
  readBooleanFlag,
  readOptionalFlag,
  type ExitCode,
  type ParsedArgs,
} from './args';

/**
 * `leafi settings`: changes the LEAFI_ALLOW_* permissions in a settings
 * file so nobody has to edit it by hand. The file is --env-file, else every
 * one in use: Hermes's when the plugin is installed, and the data directory's
 * when it exists or Hermes has no plugin.
 */
export async function runSettingsCommand(parsed: ParsedArgs): Promise<ExitCode> {
  assertFlags(parsed, [...GLOBAL_FLAGS, 'allow', 'deny', 'json']);
  assertNoPositionals(parsed);

  const envFlag = readOptionalFlag(parsed, 'env-file');
  const files = envFlag
    ? [{ envFile: path.resolve(process.cwd(), envFlag), hermes: false }]
    : settingsFiles(readOptionalFlag(parsed, 'data-dir'));

  await runSettings({
    files,
    allow: readOptionalFlag(parsed, 'allow'),
    deny: readOptionalFlag(parsed, 'deny'),
    json: readBooleanFlag(parsed, 'json'),
  });
  return EXIT.success;
}
