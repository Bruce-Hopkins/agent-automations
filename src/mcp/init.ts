import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { setEnvValues } from '../config/env-file';
import { askChecklist, askChoice, askSecret, type ChecklistItem } from '../config/terminal-prompt';
import { PROVIDER_CATALOG } from '../providers/provider-catalog';
import { findAgents, mcpEntry, SERVER_NAME, type Agent, type InstallResult } from './agents';
import {
  dataSettingsFile,
  hermesSettingsFile,
  isSet,
  isTrue,
  mailboxMissing,
  PERMISSIONS,
  PERMISSIONS_QUESTION,
  permissionChanges,
  readSettingsFile,
  SETTINGS_URL,
  writePrivate,
  type SettingsFile,
} from './settings';

export interface InitPrompts {
  choice(question: string, labels: readonly string[]): Promise<number>;
  secret(question: string): Promise<string>;
  /** Returns, per item, whether it is ticked when the person confirms. */
  checklist(question: string, items: readonly ChecklistItem[]): Promise<boolean[]>;
}

export const AGENTS_QUESTION = 'Where should leafi be installed?';

export interface InitResult {
  envFile: string;
  /** What was written: key names without their values, and `LEAFI_ALLOW_*=<value>`. */
  saved: string[];
  /** Whether the file now holds at least one provider key. */
  keyConfigured: boolean;
  /** Email is allowed, but the file has no mailbox login for it to use. */
  mailboxMissing: boolean;
}

export interface SetupOptions {
  /** Save the settings to this file instead of where each agent's server reads them. */
  envFile?: string;
}

/**
 * The server's `init`, which the installer runs. It asks which of the agents
 * on this machine to install leafi into, then for one provider
 * key and the permissions, saves them where those agents' servers read them,
 * and only then installs, so a server starts with its key. Nothing is
 * installed into an agent that was not ticked, and without a terminal nothing
 * is installed or written at all. Returns 0, or 1 when there is no terminal or
 * an install failed.
 */
export async function runSetup(options: SetupOptions): Promise<number> {
  const server = serverScript();
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    process.stderr.write(
      'init asks where to install leafi, and for an API key with the input hidden, so it needs a\n' +
        'terminal. Nothing was installed or changed. Run it in a terminal:\n' +
        `  node "${server}" init\n`,
    );
    return 1;
  }
  const agents = await findAgents();
  return setup(options, { prompts: { choice: askChoice, secret: askSecret, checklist: askChecklist }, agents, server });
}

/** init after the terminal check, with its questions and the agents found passed in, so tests can answer them. */
export async function setup(
  options: SetupOptions,
  { prompts, agents, server }: { prompts: InitPrompts; agents: readonly Agent[]; server: string },
): Promise<number> {
  let chosen: Agent[] = [];
  if (agents.length > 0) {
    const ticked = await prompts.checklist(
      AGENTS_QUESTION,
      agents.map((agent) => ({ label: `${agent.name.padEnd(15)} ${agent.detail}`, checked: true })),
    );
    chosen = agents.filter((_, index) => ticked[index] === true);
    process.stderr.write('\n');
  } else {
    process.stderr.write('No Hermes, Claude Code, Claude Desktop or Cursor was found, so this only saves your settings.\n\n');
  }

  const files = settingsFilesFor(chosen, options);
  process.stderr.write(`Saving settings to ${files.map((file) => file.envFile).join(' and ')}\n\n`);
  const results = await initSettings(files, prompts);
  const installs: InstallResult[] = [];
  for (const agent of chosen) {
    installs.push(await agent.install(server));
  }
  process.stderr.write(summary(results, chosen, installs, server));
  return installs.every((install) => install.ok) ? 0 : 1;
}

/**
 * Where the settings go: Hermes's `.env` for the Hermes plugin, and always the
 * data directory's, which every other agent's server and the
 * leafi command read. Without it, a person who ticked only
 * Hermes could not `run` a flow from the command.
 */
function settingsFilesFor(chosen: readonly Agent[], options: SetupOptions): SettingsFile[] {
  if (options.envFile) {
    return [{ envFile: path.resolve(options.envFile), hermes: chosen.length > 0 && chosen.every((agent) => agent.readsHermesEnv) }];
  }
  return chosen.some((agent) => agent.readsHermesEnv) ? [hermesSettingsFile(), dataSettingsFile()] : [dataSettingsFile()];
}

/**
 * Asks for one provider key and the LEAFI_ALLOW_* policy once,
 * and writes to each file only the answers that change what its server
 * reads; every other line is kept. A key counts as set only when every file
 * has it. A permission no file sets is offered as it recommends (see
 * `PERMISSIONS`); one a file sets is ticked only when every file that sets it
 * allows it. The data directory's
 * file is created even when nothing changes, so `settings` knows it is in use.
 */
export async function initSettings(files: readonly SettingsFile[], prompts: InitPrompts): Promise<InitResult[]> {
  const read = await Promise.all(
    files.map(async (file) => {
      const { existing, renamed } = await readSettingsFile(file.envFile);
      return { file, existing, renamed, current: parse(existing ?? '') };
    }),
  );
  const everywhere = (name: string) => read.every(({ current }) => isSet(current, name));

  const labels = PROVIDER_CATALOG.map((entry) => (everywhere(entry.envKey) ? `${entry.label} (key already set)` : entry.label));
  const provider = PROVIDER_CATALOG[await prompts.choice('Which provider will you use?', labels)];
  if (!provider) {
    throw new Error('No provider was chosen.');
  }
  const key = (
    await prompts.secret(`${provider.envKey} (input hidden, Enter to ${everywhere(provider.envKey) ? 'keep the current key' : 'skip'}): `)
  ).trim();

  // Unlike `settings`, which shows what the server reads now, init offers a
  // permission no file sets as the permission recommends: the ones confined to
  // the run's workspace ticked, the rest unticked.
  const ticked = await prompts.checklist(
    PERMISSIONS_QUESTION,
    PERMISSIONS.map(({ name, label, offered }) => {
      const setIn = read.filter(({ current }) => isSet(current, name));
      return { label, checked: setIn.length === 0 ? offered : setIn.every(({ current }) => isTrue(current[name])) };
    }),
  );
  const allowed = new Map(PERMISSIONS.map(({ name }, index) => [name, ticked[index] ?? false]));

  const results: InitResult[] = [];
  for (const { file, existing, renamed, current } of read) {
    const values: Record<string, string> = key.length > 0 ? { [provider.envKey]: key } : {};
    Object.assign(values, permissionChanges(current, allowed));
    const create = existing === undefined && !file.hermes;
    if (Object.keys(values).length > 0 || create || renamed) {
      const content = create
        ? setEnvValues(`# leafi settings. Every setting: ${SETTINGS_URL}\n`, values)
        : setEnvValues(existing ?? '', values, file.hermes ? 'leafi plugin' : 'leafi');
      await writePrivate(file.envFile, content);
    }
    results.push({
      envFile: file.envFile,
      saved: Object.keys(values).map((name) => (name.startsWith('LEAFI_ALLOW_') ? `${name}=${values[name]}` : name)),
      keyConfigured: key.length > 0 || PROVIDER_CATALOG.some((entry) => isSet(current, entry.envKey)),
      mailboxMissing: mailboxMissing(current, allowed),
    });
  }
  return results;
}

/**
 * This server's own file, for the agents' configs and the lines that tell a
 * person how to start it. Run as the leafi command, argv[1] is
 * the link, so it is followed to the server.mjs the link names. Only that
 * link is followed: a folder link in the path stays as the person wrote it.
 */
export function serverScript(): string {
  const script = path.resolve(process.argv[1] ?? 'server.mjs');
  try {
    return lstatSync(script).isSymbolicLink() ? path.resolve(path.dirname(script), readlinkSync(script)) : script;
  } catch {
    return script;
  }
}

function summary(results: readonly InitResult[], chosen: readonly Agent[], installs: readonly InstallResult[], server: string): string {
  const lines = [''];
  for (const result of results) {
    lines.push(result.saved.length > 0 ? `Saved to ${result.envFile}: ${result.saved.join(', ')}` : `Nothing changed in ${result.envFile}`);
  }
  lines.push(...installs.map((install) => install.line));
  const noKey = results.filter((result) => !result.keyConfigured).map((result) => result.envFile);
  if (noKey.length > 0) {
    lines.push(`${noKey.join(' and ')} ${noKey.length > 1 ? 'have' : 'has'} no provider key yet, so start_run fails pre-flight until you add one.`);
  }
  const noMailbox = results.filter((result) => result.mailboxMissing).map((result) => result.envFile);
  if (noMailbox.length > 0) {
    lines.push(
      `Email is allowed, but ${noMailbox.join(' and ')} ${noMailbox.length > 1 ? 'have' : 'has'} no LEAFI_EMAIL_ADDRESS and LEAFI_EMAIL_APP_PASSWORD yet: ${SETTINGS_URL}`,
    );
  }

  lines.push('', 'Next:');
  if (chosen.some((agent) => agent.id === 'hermes')) {
    lines.push('  Hermes: start a new session, and run `hermes gateway restart` if the gateway is running.');
  }
  const others = chosen.filter((agent) => agent.id !== 'hermes').map((agent) => agent.name);
  if (others.length > 0) {
    lines.push(`  ${others.join(', ')}: restart ${others.length > 1 ? 'each' : 'it'}, or start a new session.`);
  }
  if (chosen.length > 0) {
    lines.push('  Then ask your agent to call list_providers to check that the key arrived.');
  }
  lines.push(
    `${chosen.length > 0 ? 'For another' : '  Add the server to your'} MCP client, add this to its "mcpServers", then restart it:`,
    `    "${SERVER_NAME}": ${JSON.stringify(mcpEntry(server))}`,
    `Change the permissions later with: node "${server}" settings`,
    '',
  );
  return lines.join('\n');
}
