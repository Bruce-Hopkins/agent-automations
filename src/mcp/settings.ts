import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { UsageError } from '../app/usage-error';
import { setEnvValues } from '../config/env-file';
import { renameLegacyEnvKeys } from '../config/legacy-names';
import { askChecklist } from '../config/terminal-prompt';
import { resolveDataDir } from '../config/runtime-config';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../runtime/run-store';
import { hermesEnvFile, hermesPluginInstalled } from './hermes-home';
import { ALLOW_DEFAULTS, type AllowSetting } from './policy';

export const SETTINGS_URL = 'https://github.com/Bruce-Hopkins/leafi/blob/main/.env.example';

export const PERMISSIONS_QUESTION = 'Which permissions may flows use?';

export interface Permission {
  /** The short name `settings --allow` and `--deny` take. */
  id: string;
  name: AllowSetting;
  /** What it lets a flow do, for the checklist and for the question a flow's run asks. */
  about: string;
  /** The checklist line: the id, then what it lets a flow do. */
  label: string;
  /**
   * Whether init offers it ticked when no file sets it. The ones that reach
   * beyond the run's workspace start unticked; a flow that needs one asks the
   * person when it starts.
   */
  offered: boolean;
}

function permission(id: string, name: AllowSetting, about: string, offered: boolean): Permission {
  return { id, name, about, label: `${id.padEnd(11)} ${about}`, offered };
}

/**
 * Every LEAFI_ALLOW_* setting, in checklist order. The mailbox login and MCP
 * server launcher need more than a tick, so they are left to the README.
 */
export const PERMISSIONS: readonly Permission[] = [
  permission('web', 'LEAFI_ALLOW_WEB', 'fetch web pages (web_fetch)', true),
  permission('write', 'LEAFI_ALLOW_WRITE', 'write files in the run workspace (write_file)', true),
  permission('bash', 'LEAFI_ALLOW_BASH', 'run shell commands (run_bash): any command you can', false),
  permission('email', 'LEAFI_ALLOW_EMAIL', 'read your mailbox, read-only (needs a mailbox login)', false),
  permission('mcp', 'LEAFI_ALLOW_MCP', 'tools from an MCP server (default: headless Chrome)', false),
  permission('flow-paths', 'LEAFI_ALLOW_FLOW_PATHS', 'load a flow from a file path, not only inline JSON', true),
];

export type Permissions = ReadonlyMap<AllowSetting, boolean>;

/** A settings file's assignments, as dotenv parses them. */
export type EnvValues = Readonly<Record<string, string>>;

export function isSet(values: EnvValues, name: string): boolean {
  return Boolean(values[name]?.trim());
}

/** The same reading the server gives a LEAFI_ALLOW_* value. */
export function isTrue(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** What the server reads for each permission: the file's value, else its own default. */
export function serverReads(values: EnvValues): Permissions {
  return new Map(
    PERMISSIONS.map(({ name }) => [name, isSet(values, name) ? isTrue(values[name]) : ALLOW_DEFAULTS[name]]),
  );
}

/** The assignments that make the server read `wanted`, leaving out each one it already reads. */
export function permissionChanges(values: EnvValues, wanted: Permissions): Record<string, string> {
  const reads = serverReads(values);
  const changes: Record<string, string> = {};
  for (const [name, on] of wanted) {
    if (on !== reads.get(name)) {
      changes[name] = String(on);
    }
  }
  return changes;
}

/** Email is allowed, but the file has no mailbox login for it to use. */
export function mailboxMissing(values: EnvValues, wanted: Permissions): boolean {
  return wanted.get('LEAFI_ALLOW_EMAIL') === true && !(isSet(values, 'LEAFI_EMAIL_ADDRESS') && isSet(values, 'LEAFI_EMAIL_APP_PASSWORD'));
}

/** Parses an `--allow` or `--deny` value: comma-separated permission ids, or `all`. */
export function parsePermissionList(flag: string, text: string): AllowSetting[] {
  const ids = text
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new UsageError(`${flag} needs at least one permission.`);
  }
  if (ids.includes('all')) {
    return PERMISSIONS.map(({ name }) => name);
  }
  return ids.map((id) => {
    const found = PERMISSIONS.find((entry) => entry.id === id);
    if (!found) {
      throw new UsageError(`Unknown permission "${id}" for ${flag}. Use ${PERMISSIONS.map((entry) => entry.id).join(', ')} or all.`);
    }
    return found.name;
  });
}

export async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Replaces the file through a temporary sibling, so an interrupted write never
 * truncates the settings, and leaves it readable by its owner only. A
 * symlinked `.env` is written through to its target.
 */
export async function writePrivate(file: string, content: string): Promise<void> {
  const target = await fs.realpath(file).catch(() => file);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await fs.chmod(temp, PRIVATE_FILE_MODE);
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** A settings file, and who reads it. */
export interface SettingsFile {
  envFile: string;
  /** Who reads it, for the lines that name the file; none for a file the person named. */
  reader?: string;
  /** It is Hermes's own `.env`, so what init adds goes under the plugin's heading. */
  hermes: boolean;
}

/** Hermes's `.env`, which the plugin reads through the names `mcp.json` forwards. */
export function hermesSettingsFile(): SettingsFile {
  return { envFile: hermesEnvFile(), reader: 'the Hermes plugin', hermes: true };
}

/**
 * The data directory's `.env`, which the server reads for Claude Code, Cursor
 * and every other MCP client, and the leafi command reads too.
 */
export function dataSettingsFile(dataDir?: string): SettingsFile {
  return {
    envFile: path.join(resolveDataDir(dataDir), '.env'),
    reader: 'the leafi command and the MCP server for your other clients',
    hermes: false,
  };
}

/**
 * The files `settings` changes when none is named: Hermes's when the plugin
 * is installed there, and the data directory's when it exists (init always
 * creates it) or Hermes has no plugin.
 */
export function settingsFiles(dataDir?: string): SettingsFile[] {
  const data = dataSettingsFile(dataDir);
  if (!hermesPluginInstalled()) {
    return [data];
  }
  return fsSync.existsSync(data.envFile) ? [hermesSettingsFile(), data] : [hermesSettingsFile()];
}

export interface SettingsResult {
  envFile: string;
  reader?: string;
  /** Each permission by id, as the server will read it. */
  permissions: Record<string, boolean>;
  /** What was written, as `LEAFI_ALLOW_*=<value>`. */
  saved: string[];
  mailboxMissing: boolean;
}

/**
 * Reads the permissions in each file, lets `choose` change them (one answer
 * per file, in order), and writes only the lines that change what the server
 * reads. Every other line is kept.
 */
export async function changePermissions(
  files: readonly SettingsFile[],
  choose: (reads: readonly Permissions[]) => Promise<readonly Permissions[]>,
): Promise<SettingsResult[]> {
  const read = await Promise.all(
    files.map(async (file) => {
      const { existing, renamed } = await readSettingsFile(file.envFile);
      return { file, existing, renamed, values: parse(existing ?? '') };
    }),
  );
  const wanted = await choose(read.map(({ values }) => serverReads(values)));
  return Promise.all(
    read.map(async ({ file, existing, renamed, values }, index) => {
      const want = wanted[index] ?? serverReads(values);
      const changes = permissionChanges(values, want);
      if (Object.keys(changes).length > 0 || renamed) {
        await writePrivate(file.envFile, setEnvValues(existing ?? '', changes, 'leafi permissions'));
      }
      return {
        envFile: file.envFile,
        ...(file.reader ? { reader: file.reader } : {}),
        permissions: Object.fromEntries(PERMISSIONS.map(({ id, name }) => [id, want.get(name) ?? false])),
        saved: Object.entries(changes).map(([name, value]) => `${name}=${value}`),
        mailboxMissing: mailboxMissing(values, want),
      };
    }),
  );
}

/**
 * A settings file's text with names from before the rename (`AGENTS_AUTOMATIONS_*`)
 * already changed to `LEAFI_*`, and whether any were, so the caller saves it
 * even when nothing else changes. Undefined text for a missing file.
 */
export async function readSettingsFile(file: string): Promise<{ existing: string | undefined; renamed: boolean }> {
  const raw = await readIfPresent(file);
  const existing = raw === undefined ? undefined : renameLegacyEnvKeys(raw);
  return { existing, renamed: existing !== raw };
}

export interface SettingsOptions {
  files: readonly SettingsFile[];
  allow?: string;
  deny?: string;
  json: boolean;
}

/**
 * The `settings` command, shared by `leafi` and the MCP server.
 * With `--allow`/`--deny` it changes the named permissions in every file and
 * asks nothing, `--deny` winning over `--allow`. Otherwise, in a terminal, it
 * shows one checklist, ticked where every file allows the permission, and
 * saves the answer to every file; off a terminal it only prints the
 * permissions. Returns the exit code.
 */
export async function runSettings(options: SettingsOptions): Promise<number> {
  const allow = options.allow === undefined ? [] : parsePermissionList('--allow', options.allow);
  const deny = options.deny === undefined ? [] : parsePermissionList('--deny', options.deny);
  const fromFlags = options.allow !== undefined || options.deny !== undefined;
  const interactive = !fromFlags && process.stdin.isTTY === true && process.stderr.isTTY === true;

  const results = await changePermissions(options.files, async (reads) => {
    if (fromFlags) {
      return reads.map((read) => {
        const wanted = new Map(read);
        allow.forEach((name) => wanted.set(name, true));
        deny.forEach((name) => wanted.set(name, false));
        return wanted;
      });
    }
    if (!interactive) {
      return reads;
    }
    process.stderr.write(`Permissions in ${options.files.map(where).join(' and ')}\n`);
    const differ = PERMISSIONS.filter(({ name }) => new Set(reads.map((read) => read.get(name))).size > 1);
    if (differ.length > 0) {
      process.stderr.write(
        `The files differ on ${differ.map(({ id }) => id).join(', ')}, shown unticked; what you save applies to both.\n`,
      );
    }
    process.stderr.write('\n');
    const ticked = await askChecklist(
      PERMISSIONS_QUESTION,
      PERMISSIONS.map(({ name, label }) => ({ label, checked: reads.every((read) => read.get(name) === true) })),
    );
    const wanted: Permissions = new Map(PERMISSIONS.map(({ name }, index) => [name, ticked[index] ?? false]));
    return reads.map(() => wanted);
  });

  if (options.json || process.stdout.isTTY !== true) {
    process.stdout.write(`${JSON.stringify({ files: results }, null, 2)}\n`);
  }
  process.stderr.write(settingsSummary(results, fromFlags || interactive));
  return 0;
}

function where(file: { envFile: string; reader?: string }): string {
  return file.reader ? `${file.envFile} (read by ${file.reader})` : file.envFile;
}

function settingsSummary(results: readonly SettingsResult[], couldChange: boolean): string {
  const lines: string[] = [];
  if (!couldChange) {
    for (const result of results) {
      lines.push(`Permissions in ${where(result)}:`);
      for (const { id } of PERMISSIONS) {
        lines.push(`  ${id.padEnd(11)} ${result.permissions[id] ? 'allowed' : 'denied'}`);
      }
      lines.push('');
    }
    lines.push('Change them with --allow and --deny, or run this in a terminal for a checklist.');
    lines.push('Another file: --env-file <path>.');
  } else {
    lines.push('');
    for (const result of results) {
      lines.push(result.saved.length > 0 ? `Saved to ${result.envFile}: ${result.saved.join(', ')}` : `Nothing changed in ${result.envFile}`);
    }
  }
  for (const result of results) {
    if (result.mailboxMissing) {
      lines.push(`Email is allowed, but ${result.envFile} has no LEAFI_EMAIL_ADDRESS and LEAFI_EMAIL_APP_PASSWORD yet: ${SETTINGS_URL}`);
    }
  }
  if (results.some((result) => result.saved.length > 0)) {
    lines.push(
      'The server reads these when it starts: start a new Hermes session (and run `hermes gateway restart`',
      'if the gateway is running), or restart your MCP client.',
    );
  }
  return `${lines.join('\n')}\n`;
}
