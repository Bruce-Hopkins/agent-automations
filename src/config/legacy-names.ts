import { readEnv } from './runtime-config';

/**
 * leafi was called agents-automations until 0.0.3. These are the old names an
 * existing install may still use; they are read, with a warning, so an update
 * does not silently drop a person's settings. Remove after a few releases.
 */
export const LEGACY_ENV_PREFIX = 'AGENTS_AUTOMATIONS_';
export const ENV_PREFIX = 'LEAFI_';
/** The data directory's old folder name, under the home directory. */
export const LEGACY_DATA_DIR_NAME = '.agents-automations';
/** The name the MCP server and Hermes plugin were added under. */
export const LEGACY_SERVER_NAME = 'agents-automations';

const warned = new Set<string>();

/** `AGENTS_AUTOMATIONS_X` → `LEAFI_X`; undefined for any other name. */
export function currentEnvName(legacyName: string): string | undefined {
  return legacyName.startsWith(LEGACY_ENV_PREFIX) ? ENV_PREFIX + legacyName.slice(LEGACY_ENV_PREFIX.length) : undefined;
}

/**
 * Copies each `AGENTS_AUTOMATIONS_*` variable to its `LEAFI_*` name when that
 * name is unset, and warns once per name on stderr. A `LEAFI_*` value that is
 * set always wins. Returns the old names it adopted this call.
 */
export function adoptLegacyEnv(write: (text: string) => void = (text) => process.stderr.write(text)): string[] {
  const adopted: string[] = [];
  for (const legacy of Object.keys(process.env)) {
    const current = currentEnvName(legacy);
    const value = readEnv(legacy);
    if (!current || value === undefined || readEnv(current) !== undefined) {
      continue;
    }
    process.env[current] = value;
    adopted.push(legacy);
  }
  const fresh = adopted.filter((name) => !warned.has(name));
  if (fresh.length > 0) {
    fresh.forEach((name) => warned.add(name));
    const pairs = fresh.map((name) => `${name} → ${currentEnvName(name)}`).join(', ');
    write(`leafi: warning: read old setting names, which still work for now. Rename them: ${pairs}.\n`);
  }
  return adopted;
}

/**
 * Renames `AGENTS_AUTOMATIONS_*` assignments in a dotenv text to `LEAFI_*`,
 * keeping every value, comment and other line. An old name whose new name is
 * already assigned is left as it was, so a value is never overwritten.
 */
export function renameLegacyEnvKeys(content: string): string {
  const assigned = (name: string) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=`, 'm').test(content);
  return content.replace(
    /^([ \t]*(?:export[ \t]+)?)(AGENTS_AUTOMATIONS_[A-Za-z0-9_]+)([ \t]*=)/gm,
    (line, lead: string, legacy: string, equals: string) => {
      const current = currentEnvName(legacy)!;
      return assigned(current) ? line : `${lead}${current}${equals}`;
    },
  );
}
