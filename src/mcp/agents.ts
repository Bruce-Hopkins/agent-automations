import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_SERVER_NAME } from '../config/legacy-names';
import { HERMES_PLUGIN_NAME } from './hermes-home';
import { readIfPresent, writePrivate } from './settings';

/** The name the server is added under, in every agent. */
export const SERVER_NAME = 'leafi';

/** Where Hermes installs the plugin from, unless LEAFI_PLUGIN_SOURCE says otherwise. */
export const DEFAULT_PLUGIN_SOURCE = 'Bruce-Hopkins/leafi/hermes-plugin';

export type AgentId = 'hermes' | 'claude-code' | 'claude-desktop' | 'cursor';

export interface InstallResult {
  ok: boolean;
  /** One line for init's summary, starting with the agent's name. */
  line: string;
}

/** An agent found on this machine, which init offers to install leafi into. */
export interface Agent {
  id: AgentId;
  name: string;
  /** What ticking it does, shown after the name in the checklist. */
  detail: string;
  /** Its server reads Hermes's settings file, not the data directory's. */
  readsHermesEnv: boolean;
  /** Adds `server` to the agent. Never asks: the person already ticked it. */
  install(server: string): Promise<InstallResult>;
}

/**
 * The agents this machine has, in checklist order: Hermes and Claude Code when
 * their command is on the PATH, Claude Desktop and Cursor when their settings
 * folder exists. Nothing is changed.
 */
export async function findAgents(pluginSource = process.env.LEAFI_PLUGIN_SOURCE?.trim() || DEFAULT_PLUGIN_SOURCE): Promise<Agent[]> {
  const agents: Agent[] = [];
  const hermes = findCommand('hermes');
  if (hermes) {
    agents.push(hermesAgent(hermes, await hermesStatus(hermes), pluginSource));
  }
  const claude = findCommand('claude');
  if (claude) {
    agents.push(claudeCodeAgent(claude));
  }
  for (const app of configFileApps()) {
    if (fs.existsSync(app.dir)) {
      agents.push(configFileAgent(app, await readMcpConfig(app.file)));
    }
  }
  return agents;
}

/** The full path of a command on the PATH, as a shell would find it, or undefined. */
export function findCommand(name: string): string | undefined {
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const extension of extensions) {
      const file = path.join(dir, `${name}${extension}`);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) {
          return file;
        }
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined;
}

type PluginStatus = 'missing' | 'enabled' | 'disabled';

/**
 * Hermes installs and enables the plugin with its own commands, so its source
 * warning, security scan and after-install note reach the person unchanged.
 * An installed plugin is never reinstalled, only enabled if it was turned off.
 */
function hermesAgent(command: string, status: PluginStatus, source: string): Agent {
  return {
    id: 'hermes',
    name: 'Hermes',
    readsHermesEnv: true,
    detail:
      status === 'enabled'
        ? 'the plugin is installed and enabled'
        : status === 'disabled'
          ? 'enables the installed plugin'
          : 'installs and enables the Hermes plugin',
    async install() {
      if (status === 'enabled') {
        return { ok: true, line: `Hermes: the plugin was already installed and enabled.${await legacyHermesNote(command)}` };
      }
      const args = status === 'missing' ? ['plugins', 'install', source, '--enable'] : ['plugins', 'enable', HERMES_PLUGIN_NAME];
      process.stderr.write(`\nRunning: hermes ${args.join(' ')}\n\n`);
      const { code } = await run(command, args, 'inherit');
      if (code !== 0) {
        return { ok: false, line: `Hermes: "hermes ${args.join(' ')}" failed (exit ${code}). Fix what Hermes reported, then run this again.` };
      }
      const after = await hermesStatus(command);
      if (after !== 'enabled') {
        return { ok: false, line: `Hermes: the plugin is ${after === 'missing' ? 'not installed' : 'not enabled'}. Run "hermes plugins show ${HERMES_PLUGIN_NAME}" to see why.` };
      }
      return {
        ok: true,
        line:
          (status === 'missing' ? `Hermes: installed and enabled the plugin from ${source}.` : 'Hermes: enabled the plugin.') +
          (await legacyHermesNote(command)),
      };
    },
  };
}

/**
 * A note when the plugin from before the rename is still installed, which would
 * give Hermes the same tools twice. It is not removed here: its data folder
 * holds the person's saved flows and runs.
 */
async function legacyHermesNote(command: string): Promise<string> {
  if ((await hermesStatus(command, LEGACY_SERVER_NAME)) === 'missing') {
    return '';
  }
  return ` The plugin's old version, ${LEGACY_SERVER_NAME}, is still installed; once you have copied any flows you want from it, remove it with "hermes plugins remove ${LEGACY_SERVER_NAME}".`;
}

/** Reads `hermes plugins show`, which fails for a plugin Hermes does not have. */
async function hermesStatus(command: string, name = HERMES_PLUGIN_NAME): Promise<PluginStatus> {
  const { code, output } = await run(command, ['plugins', 'show', name], 'pipe');
  if (code !== 0) {
    return 'missing';
  }
  // Hermes prints "Status: enabled", "disabled" or "not enabled".
  const status = /^\s*Status:\s*(.+?)\s*$/m.exec(output.replace(/\u001b\[[0-9;]*m/g, ''))?.[1];
  return status === 'enabled' ? 'enabled' : 'disabled';
}

/** Claude Code adds servers with its own command, at user scope, so it works in every project. */
function claudeCodeAgent(command: string): Agent {
  const added = claudeCodeHasServer();
  const legacy = claudeCodeHasServer(LEGACY_SERVER_NAME);
  return {
    id: 'claude-code',
    name: 'Claude Code',
    readsHermesEnv: false,
    detail: added ? 'the server is already added' : 'adds the server with "claude mcp add", for all projects',
    async install(server) {
      // The entry from before the rename points at the old server file, which
      // the installer moved, so it is replaced rather than left broken.
      const removed = legacy && (await run(command, ['mcp', 'remove', '--scope', 'user', LEGACY_SERVER_NAME], 'pipe')).code === 0;
      const replaced = removed ? ` and removed the old ${LEGACY_SERVER_NAME} entry` : '';
      if (added) {
        return { ok: true, line: `Claude Code: the server was already added${replaced}.` };
      }
      const args = ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', 'node', server, '--transport', 'stdio'];
      const { code, output } = await run(command, args, 'pipe');
      if (code !== 0) {
        return {
          ok: false,
          line: `Claude Code: "claude ${args.join(' ')}" failed (exit ${code})${output.trim() ? `: ${output.trim().split('\n').pop()}` : ''}`,
        };
      }
      return { ok: true, line: `Claude Code: added the server for all projects${replaced}.` };
    },
  };
}

/** Whether Claude Code's user settings already list the server. A file it cannot read counts as no. */
function claudeCodeHasServer(name = SERVER_NAME): boolean {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || os.homedir();
  try {
    const config: unknown = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    return isObject(config) && isObject(config.mcpServers) && name in config.mcpServers;
  } catch {
    return false;
  }
}

interface ConfigFileApp {
  id: 'claude-desktop' | 'cursor';
  name: string;
  /** The app's settings folder: the app counts as installed when it exists. */
  dir: string;
  /** Its MCP settings file, with an `mcpServers` object. */
  file: string;
}

function configFileApps(): ConfigFileApp[] {
  const home = os.homedir();
  const desktop =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming'), 'Claude')
        : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'Claude');
  return [
    { id: 'claude-desktop', name: 'Claude Desktop', dir: desktop, file: path.join(desktop, 'claude_desktop_config.json') },
    { id: 'cursor', name: 'Cursor', dir: path.join(home, '.cursor'), file: path.join(home, '.cursor', 'mcp.json') },
  ];
}

/**
 * The server's entry in an app's MCP settings file. Apps started from the
 * desktop do not get the shell's PATH, so it names Node by its full path: the
 * `node` on the PATH, which survives an upgrade, rather than this process's
 * own binary, which is often a versioned path (Homebrew's Cellar, Fedora's
 * node-22).
 */
export function mcpEntry(server: string): { command: string; args: string[] } {
  return { command: findCommand('node') ?? process.execPath, args: [server, '--transport', 'stdio'] };
}

function configFileAgent(app: ConfigFileApp, config: McpConfig): Agent {
  const shown = tilde(app.file);
  return {
    id: app.id,
    name: app.name,
    readsHermesEnv: false,
    detail: config.servers?.[LEGACY_SERVER_NAME]
      ? `replaces the old ${LEGACY_SERVER_NAME} entry in ${shown}`
      : config.servers?.[SERVER_NAME]
        ? `the server is already in ${shown}`
        : `adds the server to ${shown}`,
    async install(server) {
      try {
        const change = await addToMcpConfig(app.file, mcpEntry(server));
        const done = { added: `added the server to ${shown}`, updated: `updated the server in ${shown}`, unchanged: 'the server was already added' };
        return { ok: true, line: `${app.name}: ${done[change]}.` };
      } catch (error) {
        return {
          ok: false,
          line: `${app.name}: ${shown} was left as it was, because ${error instanceof Error ? error.message : String(error)}. Add the server by hand: "${SERVER_NAME}": ${JSON.stringify(mcpEntry(server))}`,
        };
      }
    },
  };
}

interface McpConfig {
  servers?: Record<string, unknown>;
}

async function readMcpConfig(file: string): Promise<McpConfig> {
  try {
    const parsed: unknown = JSON.parse((await readIfPresent(file)) ?? '{}');
    return isObject(parsed) && isObject(parsed.mcpServers) ? { servers: parsed.mcpServers } : {};
  } catch {
    return {};
  }
}

/**
 * Sets the server's entry in an MCP settings file, keeping everything else in
 * it. A missing file is created. A file that is not a JSON object, or whose
 * `mcpServers` is not one, is refused unchanged rather than guessed at.
 */
export async function addToMcpConfig(file: string, entry: object): Promise<'added' | 'updated' | 'unchanged'> {
  const text = (await readIfPresent(file)) ?? '';
  let config: Record<string, unknown> = {};
  if (text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('it is not valid JSON');
    }
    if (!isObject(parsed)) {
      throw new Error('it is not a JSON object');
    }
    config = parsed;
  }
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) {
    throw new Error('its "mcpServers" is not an object');
  }
  const before = servers[SERVER_NAME];
  // The entry from before the rename points at the old server file, which the
  // installer moved, so it is replaced rather than left broken.
  const { [LEGACY_SERVER_NAME]: legacy, ...rest } = servers;
  if (legacy === undefined && JSON.stringify(before) === JSON.stringify(entry)) {
    return 'unchanged';
  }
  config.mcpServers = { ...rest, [SERVER_NAME]: entry };
  await writePrivate(file, `${JSON.stringify(config, null, 2)}\n`);
  return before === undefined && legacy === undefined ? 'added' : 'updated';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tilde(file: string): string {
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/**
 * Runs a command: on this terminal with `inherit`, so its questions reach the
 * person, or with its output collected. A Windows `.cmd` or `.bat` needs a
 * shell, so its arguments are quoted for one.
 */
function run(command: string, args: string[], stdio: 'inherit' | 'pipe'): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const options: SpawnOptions = { stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'] };
    const child: ChildProcess = viaShell
      ? spawn([command, ...args].map((arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)).join(' '), {
          ...options,
          shell: true,
        })
      : spawn(command, args, options);
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.once('error', (error) => resolve({ code: -1, output: error.message }));
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
