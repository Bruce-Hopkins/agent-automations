import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_CATALOG, type ProviderDefinition } from '../providers/provider-catalog';
import { DEFAULT_MCP_TOOLS } from '../tools/mcp/mcp-toolkit';
import type { EmailCredentials, ProviderId } from '../domain/types';

const DEFAULT_IMAP_HOST = 'imap.gmail.com';
const DEFAULT_IMAP_PORT = 993;
/**
 * Headless and isolated by default: no cookie jar to keep, no display to need.
 * Pinned to an exact version so a new release never runs unreviewed; to upgrade,
 * change it here, in `.env.example` and in the READMEs together.
 */
export const DEFAULT_MCP_COMMAND = 'npx -y chrome-devtools-mcp@1.10.1 --headless --isolated';
/** An MCP host may forward `${VAR}` verbatim when the variable is unset. */
const UNRESOLVED_ENV_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const DEFAULTS = {
  maxNodeIterations: 25,
  maxRunSteps: 200,
  maxParallelNodes: 4,
  runTimeoutMs: 30 * 60 * 1000,
  bashTimeoutMs: 2 * 60 * 1000,
  bashTimeoutMaxMs: 10 * 60 * 1000,
  jobTimeoutMs: 30 * 60 * 1000,
  modelCallTimeoutMs: 5 * 60 * 1000,
  toolOutputLimitBytes: 32 * 1024,
  toolOutputSaveLimitBytes: 1024 * 1024,
  toolOutputStepLimitBytes: 128 * 1024,
  webFetchTimeoutMs: 20 * 1000,
  webFetchLimitBytes: 256 * 1024,
  emailTimeoutMs: 20 * 1000,
  mcpTimeoutMs: 120 * 1000,
  mcpMaxConcurrentRuns: 2,
  mcpMaxFlowBytes: 256 * 1024,
  mcpMaxResultBytes: 256 * 1024,
} as const;

export interface RuntimeConfigOptions {
  /** Overrides `DATA_DIR`, `LEAFI_HOME` and the home-directory default. */
  dataDir?: string;
}

export class RuntimeConfig {
  readonly dataDir: string;
  readonly maxNodeIterations: number;
  readonly maxRunSteps: number;
  /** Agents allowed to run at once. 1 restores fully sequential execution. */
  readonly maxParallelNodes: number;
  readonly runTimeoutMs: number;
  /** How long a shell command runs when it does not ask for longer. */
  readonly bashTimeoutMs: number;
  /** The most a shell command may ask for with `timeoutSeconds`. */
  readonly bashTimeoutMaxMs: number;
  /** The longest a background job may run. */
  readonly jobTimeoutMs: number;
  /** How long one model call may take before it is retried once. */
  readonly modelCallTimeoutMs: number;
  readonly toolOutputLimitBytes: number;
  /** The most an oversized tool result saved to the workspace may hold. */
  readonly toolOutputSaveLimitBytes: number;
  /** The most all tool results of one model response may return together. */
  readonly toolOutputStepLimitBytes: number;
  readonly webFetchTimeoutMs: number;
  readonly webFetchLimitBytes: number;
  /** How long one IMAP operation may take before it is abandoned. */
  readonly emailTimeoutMs: number;
  /** Launcher for the MCP server an `mcp` node talks to; a headless Chrome by default. */
  readonly mcpCommand: string;
  /** Budget for the MCP handshake and for any single MCP tool call. */
  readonly mcpTimeoutMs: number;
  /** The MCP server's tools a node may hold, by name. */
  readonly mcpTools: readonly string[];
  readonly mcpMaxConcurrentRuns: number;
  readonly mcpMaxFlowBytes: number;
  readonly mcpMaxResultBytes: number;
  readonly isRoot: boolean;

  constructor(options: RuntimeConfigOptions = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    this.maxNodeIterations = readInt('MAX_NODE_ITERATIONS', DEFAULTS.maxNodeIterations);
    this.maxRunSteps = readInt('MAX_RUN_STEPS', DEFAULTS.maxRunSteps);
    this.maxParallelNodes = readInt('MAX_PARALLEL_NODES', DEFAULTS.maxParallelNodes);
    this.runTimeoutMs = readInt('RUN_TIMEOUT_MS', DEFAULTS.runTimeoutMs);
    this.bashTimeoutMs = readInt('BASH_TIMEOUT_MS', DEFAULTS.bashTimeoutMs);
    // A default longer than the cap raises the cap with it, so an older setting keeps working.
    this.bashTimeoutMaxMs = Math.max(readInt('BASH_TIMEOUT_MAX_MS', DEFAULTS.bashTimeoutMaxMs), this.bashTimeoutMs);
    this.jobTimeoutMs = readInt('JOB_TIMEOUT_MS', DEFAULTS.jobTimeoutMs);
    this.modelCallTimeoutMs = readInt('MODEL_CALL_TIMEOUT_MS', DEFAULTS.modelCallTimeoutMs);
    this.toolOutputLimitBytes = readInt('BASH_OUTPUT_LIMIT_BYTES', DEFAULTS.toolOutputLimitBytes);
    this.toolOutputSaveLimitBytes = readInt('TOOL_OUTPUT_SAVE_LIMIT_BYTES', DEFAULTS.toolOutputSaveLimitBytes);
    this.toolOutputStepLimitBytes = readInt('TOOL_OUTPUT_STEP_LIMIT_BYTES', DEFAULTS.toolOutputStepLimitBytes);
    this.webFetchTimeoutMs = readInt('WEB_FETCH_TIMEOUT_MS', DEFAULTS.webFetchTimeoutMs);
    this.webFetchLimitBytes = readInt('WEB_FETCH_LIMIT_BYTES', DEFAULTS.webFetchLimitBytes);
    this.emailTimeoutMs = readInt('LEAFI_EMAIL_TIMEOUT_MS', DEFAULTS.emailTimeoutMs);
    this.mcpCommand = readEnv('LEAFI_MCP_COMMAND') ?? DEFAULT_MCP_COMMAND;
    this.mcpTimeoutMs = readInt('LEAFI_MCP_TIMEOUT_MS', DEFAULTS.mcpTimeoutMs);
    this.mcpTools = readList('LEAFI_MCP_TOOLS', DEFAULT_MCP_TOOLS);
    this.mcpMaxConcurrentRuns = readInt('MCP_MAX_CONCURRENT_RUNS', DEFAULTS.mcpMaxConcurrentRuns);
    this.mcpMaxFlowBytes = readInt('MCP_MAX_FLOW_BYTES', DEFAULTS.mcpMaxFlowBytes);
    this.mcpMaxResultBytes = readInt('MCP_MAX_RESULT_BYTES', DEFAULTS.mcpMaxResultBytes);
    this.isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  }

  get runsDir(): string {
    return path.join(this.dataDir, 'runs');
  }

  get workspacesDir(): string {
    return path.join(this.dataDir, 'workspaces');
  }

  /**
   * The mailbox login, or undefined when it is incomplete. An app password has
   * no connection step, so its presence here is the entire configuration story.
   */
  emailCredentials(): EmailCredentials | undefined {
    const address = readEnv('LEAFI_EMAIL_ADDRESS');
    const appPassword = readEnv('LEAFI_EMAIL_APP_PASSWORD');
    if (!address || !appPassword) {
      return undefined;
    }
    return {
      address,
      appPassword,
      imapHost: readEnv('LEAFI_EMAIL_IMAP_HOST') ?? DEFAULT_IMAP_HOST,
      imapPort: readInt('LEAFI_EMAIL_IMAP_PORT', DEFAULT_IMAP_PORT),
    };
  }

  workspaceFor(runId: string): string {
    return path.join(this.workspacesDir, runId);
  }

  apiKeyFor(provider: ProviderId): string | undefined {
    const definition = PROVIDER_CATALOG.find((entry) => entry.id === provider);
    return definition ? readEnv(definition.envKey) : undefined;
  }

  availableProviders(): ProviderDefinition[] {
    return PROVIDER_CATALOG.filter((definition) => this.apiKeyFor(definition.id) !== undefined);
  }
}

/**
 * A setting's value, or undefined when it is unset, blank, or an unexpanded
 * `${VAR}` placeholder that an MCP host forwarded for a variable it did not have.
 */
export function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && !UNRESOLVED_ENV_PLACEHOLDER.test(value) ? value : undefined;
}

export function resolveDataDir(override?: string): string {
  const configured = override ?? readEnv('DATA_DIR') ?? readEnv('LEAFI_HOME');
  if (!configured) {
    return defaultDataDir();
  }
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

/**
 * `~/.leafi`, or the folder an install from before the rename left at
 * `~/.agents-automations` while `~/.leafi` does not exist yet, so its settings,
 * saved flows and runs are not left behind. An empty old folder holds nothing
 * to keep, so it is ignored. The installer moves that folder.
 */
function defaultDataDir(): string {
  const current = path.join(os.homedir(), '.leafi');
  // Kept here rather than imported from legacy-names, which imports this module.
  const legacy = path.join(os.homedir(), '.agents-automations');
  return !fs.existsSync(current) && hasEntries(legacy) ? legacy : current;
}

function hasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function readInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Only an explicit yes turns a switch on: junk and `${VAR}` placeholders read as off. */
function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function readBoolean(name: string, fallback: boolean): boolean {
  return readBool(name, fallback);
}

function readList(name: string, fallback: readonly string[]): readonly string[] {
  const raw = readEnv(name);
  if (!raw) {
    return fallback;
  }
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : fallback;
}
