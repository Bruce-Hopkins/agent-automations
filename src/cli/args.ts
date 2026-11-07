import { UsageError } from '../app/usage-error';
import { PROVIDER_CATALOG } from '../providers/provider-catalog';

export { UsageError } from '../app/usage-error';

export const EXIT = {
  success: 0,
  runFailed: 1,
  invalidInput: 2,
  usage: 3,
  environment: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];


interface FlagSpec {
  takesValue: boolean;
  description: string;
}

const FLAGS: Record<string, FlagSpec> = {
  graph: { takesValue: true, description: 'Flow JSON file, or - to read it from stdin.' },
  input: { takesValue: true, description: 'Initial run input, as literal text.' },
  'input-file': { takesValue: true, description: 'Read the initial run input from a file.' },
  json: { takesValue: false, description: 'Force machine-readable output (implied off a TTY).' },
  events: { takesValue: true, description: 'Event output: ndjson | none | pretty.' },
  strict: { takesValue: false, description: 'validate: treat design warnings as failures.' },
  format: { takesValue: true, description: 'graph: ascii | mermaid | dot.' },
  'env-file': { takesValue: true, description: 'Load environment variables from this file instead of ~/.leafi/.env.' },
  'data-dir': { takesValue: true, description: 'Store run artifacts under this directory.' },
  save: { takesValue: false, description: 'Persist run metadata and events.' },
  'no-save': { takesValue: false, description: 'Do not persist run metadata or events.' },
  diagram: { takesValue: false, description: 'Print the flow diagram before running.' },
  'no-diagram': { takesValue: false, description: 'Do not print the flow diagram before running.' },
  help: { takesValue: false, description: 'Show help for a command.' },
  version: { takesValue: false, description: 'Print the version and exit.' },
  provider: { takesValue: true, description: 'init: openai | anthropic | google | openrouter.' },
  yes: { takesValue: false, description: 'init: ask nothing; write the files and exit.' },
  allow: { takesValue: true, description: 'settings: permissions to allow, comma-separated, or all.' },
  deny: { takesValue: true, description: 'settings: permissions to deny, comma-separated, or all.' },
};

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgv(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      index = readLongFlag(argv, index, flags);
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      if (token === '-h') {
        flags.help = true;
        continue;
      }
      throw new UsageError(`Unknown flag "${token}".`);
    }

    if (command === undefined) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

function readLongFlag(argv: string[], index: number, flags: Record<string, string | boolean>): number {
  const token = argv[index] ?? '';
  const equals = token.indexOf('=');
  const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
  const spec = FLAGS[name];

  if (!spec) {
    throw new UsageError(`Unknown flag "--${name}".`);
  }

  if (!spec.takesValue) {
    if (equals !== -1) {
      throw new UsageError(`Flag "--${name}" does not take a value.`);
    }
    flags[name] = true;
    return index;
  }

  if (equals !== -1) {
    flags[name] = token.slice(equals + 1);
    return index;
  }

  const value = argv[index + 1];
  if (value === undefined) {
    throw new UsageError(`Flag "--${name}" needs a value.`);
  }
  flags[name] = value;
  return index + 1;
}

/** Rejects flags a command does not understand; `--help` is always allowed. */
export function assertFlags(parsed: ParsedArgs, allowed: string[]): void {
  const permitted = new Set([...allowed, 'help']);
  const unknown = Object.keys(parsed.flags).filter((name) => !permitted.has(name));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown flag "--${unknown[0]}" for "${parsed.command}".`);
  }
}

export const GLOBAL_FLAGS = ['env-file', 'data-dir'] as const;

export function requireFlag(parsed: ParsedArgs, name: string): string {
  const value = parsed.flags[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`"leafi ${parsed.command}" needs --${name}.`);
  }
  return value;
}

export function readBooleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function readOptionalFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function readSaveFlag(parsed: ParsedArgs): boolean {
  if (readBooleanFlag(parsed, 'save') && readBooleanFlag(parsed, 'no-save')) {
    throw new UsageError('--save and --no-save cannot be combined.');
  }
  return !readBooleanFlag(parsed, 'no-save');
}

export function assertNoPositionals(parsed: ParsedArgs): void {
  if (parsed.positionals.length > 0) {
    throw new UsageError(`Unexpected argument "${parsed.positionals[0]}".`);
  }
}

const COMMON_HEADER = `leafi - run automations made of linked LLM agents

Usage:
  leafi <command> [flags]
  leafi --version

Commands:
  init [--provider <id>] [--yes]
                              Set up ~/.leafi/.env and write a starter
                              flow.json to the current directory.
  settings [--allow <list>] [--deny <list>]
                              Choose which tools MCP clients may give flows,
                              without editing the settings file by hand.
  validate --graph <path|-> [--strict]
                              Check a flow without running it. Exits 2 on issues;
                              --strict makes design warnings exit 2 too.
  schema [example]            Print the flow JSON Schema, or a runnable example.
  run --graph <path|->        Execute a flow and wait for the result.
  graph --graph <path|->      Print the flow as ASCII, Mermaid or DOT.
  providers                   List configured providers and their models.
  runs [list|show <id>]       Inspect persisted runs.`;

const EXIT_CODES = `Exit codes:
  0  success        Run reached "completed".
  1  run failed     The flow ran but failed or was cancelled.
  2  invalid input  Malformed JSON or validation issues.
  3  usage error    Unknown flag, missing or conflicting flags.
  4  environment    Pre-flight failed before any tokens were spent: a missing
                    provider API key or mailbox credential, a rejected mailbox
                    login, or an MCP server launcher that will not start or
                    offers none of the configured tools.`;

const OUTPUT_CONTRACT = `Output:
  stdout carries data only (JSON); stderr carries progress and errors.
  With --events ndjson, one JSON object per line mirrors the run event log,
  followed by a final line: {"type":"result","run":{...}}.

Flow JSON:
  Run "leafi schema" for the JSON Schema and "leafi schema example"
  for a runnable two-node flow.`;

const RUNTIME = `Runtime:
  Settings are read from ~/.leafi/.env (the data directory's .env), or
  from --env-file. A .env in the current directory is not read.
  Run artifacts live under ~/.leafi unless --data-dir or DATA_DIR is set.
  LangSmith tracing variables are ignored unless LEAFI_LANGSMITH_TRACING=true.
  --no-save keeps the workspace but writes neither meta.json nor events.jsonl.`;

export function providerCatalogText(): string {
  const lines = PROVIDER_CATALOG.map(
    (provider) => `  ${provider.id.padEnd(11)} ${provider.label} (${provider.envKey})\n      ${provider.models.join('\n      ')}`,
  );
  return `Providers and models:\n${lines.join('\n')}`;
}

export function globalHelp(): string {
  return `${COMMON_HEADER}\n\n${EXIT_CODES}\n\n${OUTPUT_CONTRACT}\n\n${RUNTIME}\n\n${providerCatalogText()}\n`;
}

export function commandHelp(command: string | undefined): string {
  switch (command) {
    case 'init':
      return `leafi init [--provider <id>] [--yes]

Gets a new machine ready to run flows:
  - creates the data directory (~/.leafi, owner-only);
  - writes its .env settings file (owner-only) unless one exists, and, in a
    terminal, asks for one provider's API key with the input hidden;
  - writes a starter research flow to ./flow.json unless that file exists.
Existing files are never overwritten; a key you type replaces only its own line.
Prints the next commands on stderr, and what it did as JSON on stdout when
--json is given or stdout is not a terminal.

Flags:
  --provider <id>    openai | anthropic | google | openrouter. Default: the
                     provider whose key is already set, otherwise ask (or
                     anthropic with --yes or off a terminal).
  --yes              Ask nothing.
  --json             Print the JSON report even in a terminal.
  --env-file <path>  Write the settings here instead of ~/.leafi/.env.
  --data-dir <path>  Use this data directory instead of ~/.leafi.

To install into Hermes, Claude Code, Claude Desktop or Cursor, use the installer
(see the README); its setup is the MCP server's init.\n`;
    case 'settings':
      return `leafi settings [--allow <list>] [--deny <list>] [--json]

Changes which tools the MCP server (leafi-mcp, and the Hermes plugin)
lets a flow use, by writing the LEAFI_ALLOW_* lines of its settings files for you.
Flows run with "leafi run" are not limited by these.

It changes every file in use: Hermes's ($HERMES_HOME/.env or ~/.hermes/.env)
when the Hermes plugin is installed, and ~/.leafi/.env when it
exists or Hermes has no plugin. One checklist, or one --allow/--deny, applies
to all of them.

In a terminal, with neither --allow nor --deny, it shows a checklist of the
permissions as the server reads them now: move with up/down, tick or untick
with space, save with Enter. Off a terminal it only prints them.

Permissions: web, write, bash, email, mcp, flow-paths, or all.
Only lines that change what the server reads are written; every other line is
kept. The server reads them when it starts, so restart your MCP client, or start
a new Hermes session, afterwards.

Flags:
  --allow <list>     Allow these permissions without asking.
  --deny <list>      Deny these without asking; wins over --allow, so
                     "--allow all --deny bash" allows everything but bash.
  --json             Print the result as JSON even in a terminal.
  --env-file <path>  Change this file instead.
  --data-dir <path>  Use this data directory's .env instead of ~/.leafi.\n`;
    case 'validate':
      return `leafi validate --graph <path|->

Parses and validates a flow without touching a model. Prints
{"ok":bool,"issues":[...],"warnings":[...],"minimum":{...}} on stdout.
Exits 2 when there are issues. Use "-" to read the flow from stdin.

Flags:
  --graph <path|->   Flow JSON file, or - for stdin. Required.
  --strict           Treat design warnings as failures.
  --help             Show this help.\n`;
    case 'schema':
      return `leafi schema [example]

Prints the flow JSON Schema to stdout, or a runnable example with
"leafi schema example". "schema example | leafi validate --graph -"
exits 0, so the example is always valid.\n`;
    case 'run':
      return `leafi run --graph <path|-> [--input <text>|--input-file <path>] [--json] [--events <ndjson|none|pretty>]

Executes a flow, streams its events, and waits for the result.

Flags:
  --graph <path|->        Flow JSON file, or - for stdin. Required.
  --input <text>          Initial run input, as literal text.
  --input-file <path>     Read the initial run input from a file.
  --json                  Force machine-readable output (implied off a TTY).
  --events <mode>         ndjson (default off a TTY) | pretty (default on a TTY) | none.
  --diagram               Print the flow diagram before running.
  --no-diagram            Do not print the diagram.
  --save / --no-save      Persist run artifacts (default: save).
  --help                  Show this help.

${EXIT_CODES}\n\n${OUTPUT_CONTRACT}\n\n${RUNTIME}\n\n${providerCatalogText()}\n`;
    case 'graph':
      return `leafi graph --graph <path|-> [--format ascii|mermaid|dot]

Draws the flow. The ascii format is the default and fits a terminal.\n`;
    case 'providers':
      return `leafi providers

Lists the providers whose API key is configured, with the models each offers.
The list is fetched live and falls back to the static catalog.\n`;
    case 'runs':
      return `leafi runs [list|show <id>]

Lists persisted runs, or prints one run's metadata and events.\n`;
    default:
      return globalHelp();
  }
}
