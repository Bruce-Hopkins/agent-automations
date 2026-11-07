#!/usr/bin/env node
import path from 'node:path';
import { FlowLibrary } from '../app/flow-library';
import { FlowService } from '../app/flow-service';
import { RunService } from '../app/run-service';
import { disableImplicitTracing, loadEnvironment } from '../config/env';
import { adoptLegacyEnv } from '../config/legacy-names';
import { RuntimeConfig } from '../config/runtime-config';
import { EmailService } from '../email/email-service';
import { ModelFactory } from '../providers/model-factory';
import { ProviderService } from '../providers/provider-service';
import { RunExecutor } from '../runtime/run-executor';
import { RunStore } from '../runtime/run-store';
import { isFlowCommand, runCli } from '../cli/main';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from './context';
import { runSetup } from './init';
import { runSettings, settingsFiles } from './settings';
import { createStderrLogger } from './logger';
import { readMcpPolicy } from './policy';
import { createMcpResults } from './results';
import { RunManager } from './run-manager';
import { createMcpServer } from './server';
import { serveStdio } from './transports/stdio';
import { VERSION } from '../version';

interface McpArgs {
  transport: 'stdio';
  envFile?: string;
  dataDir?: string;
  noEnv: boolean;
  help: boolean;
  version: boolean;
}

const HELP = `leafi - run automations made of linked LLM agents, and serve them to an MCP client

Installed, this is ~/.leafi/server.mjs, and the installer links the
leafi command to it; from a clone, it is leafi-mcp.

Usage:
  leafi <validate|schema|graph|run|runs|providers> [flags]
                      Work with flows; "leafi <command> --help"
                      shows each command's flags.
  leafi --transport stdio [--env-file <path>] [--data-dir <path>] [--no-env]
                      Serve flows to an MCP client.
  leafi init [--env-file <path>]
  leafi settings [--allow <list>] [--deny <list>] [--json] [--env-file <path>]
  leafi --version

Without the command on your PATH, "node ~/.leafi/server.mjs" takes
the same arguments.

stdio is the only transport in this release. stdout carries MCP JSON-RPC;
all logs go to stderr. HTTP is deliberately not implemented yet.

init is the setup the installer runs. It shows a checklist of the agents on
this machine (Hermes, Claude Code, Claude Desktop, Cursor) and installs the
server only into the ones you tick. Then it asks for a provider API key (input
hidden) and which tools flows may use, and saves them where they are read:
~/.leafi/.env, for this command and every other client, and
Hermes's .env too when you tick Hermes; or only --env-file. It needs a terminal;
without one it changes nothing.

settings changes only the permissions, so nobody has to edit a file by hand. It
changes every file in use: Hermes's when the plugin is installed, and
~/.leafi/.env when it exists or Hermes has no plugin. In a terminal it
shows a checklist of what flows may use now; with --allow or --deny (web,
write, bash, email, mcp, flow-paths, or all) it asks nothing, and --deny
wins over --allow. Off a terminal with neither flag it only prints the
permissions. Restart the server afterwards: start a new Hermes session, or
restart your MCP client.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // The installed file is also the leafi command, so the flow
  // commands run exactly as they do in the CLI.
  if (isFlowCommand(argv)) {
    await runCli(argv);
    return;
  }
  const [first] = argv;
  if (first !== undefined && !first.startsWith('-') && first !== 'init' && first !== 'settings') {
    process.stderr.write(`Unknown command "${first}".\n\n${HELP}`);
    process.exitCode = 3;
    return;
  }
  // An MCP client's stdin is a pipe. A person who types the bare command gets
  // the usage instead of a server waiting in silence for a client.
  if (argv.length === 0 && process.stdin.isTTY) {
    process.stderr.write(`No command given.\n\n${HELP}`);
    process.exitCode = 3;
    return;
  }
  // init and settings find the data directory before any file is loaded, so a
  // home folder set under the old name is read here.
  adoptLegacyEnv();
  if (argv[0] === 'init') {
    const init = parseInitArgs(argv.slice(1));
    if (init.help) {
      process.stdout.write(HELP);
      return;
    }
    process.exitCode = await runSetup({ envFile: init.envFile ? path.resolve(process.cwd(), init.envFile) : undefined });
    return;
  }
  if (argv[0] === 'settings') {
    const settings = parseSettingsArgs(argv.slice(1));
    if (settings.help) {
      process.stdout.write(HELP);
      return;
    }
    process.exitCode = await runSettings({
      files: settings.envFile ? [{ envFile: path.resolve(process.cwd(), settings.envFile), hermes: false }] : settingsFiles(),
      allow: settings.allow,
      deny: settings.deny,
      json: settings.json,
    });
    return;
  }

  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  // With --no-env (the Hermes plugin) the settings arrive in the environment,
  // so there is no file to save an "always allow" to.
  const settingsFile = args.noEnv ? undefined : loadEnvironment({ envFile: args.envFile, dataDir: args.dataDir });
  disableImplicitTracing();
  const context = buildContext(args, settingsFile);

  const server = createMcpServer(context);
  process.once('SIGINT', () => void shutdown(context, server));
  process.once('SIGTERM', () => void shutdown(context, server));

  context.logger.info(`Starting stdio MCP server with data directory ${context.config.dataDir}`);
  await serveStdio(server);
}

function buildContext(args: McpArgs, settingsFile: string | undefined): McpContext {
  const config = new RuntimeConfig({ dataDir: args.dataDir });
  const logger = createStderrLogger();
  const store = new RunStore(config);
  const email = new EmailService(config);
  const executor = new RunExecutor(config, store, new ModelFactory(config), email, {
    info: () => undefined,
    error: (message) => logger.error(message),
  });
  const runs = new RunService(config, store, executor, email);
  const policy = readMcpPolicy(config);

  return {
    config,
    flows: new FlowService(),
    library: new FlowLibrary(config),
    runs,
    runManager: new RunManager(runs, store, policy),
    store,
    providers: new ProviderService(config),
    policy,
    ...(settingsFile !== undefined ? { settingsFile } : {}),
    logger,
    results: createMcpResults(policy.maxResultBytes),
  };
}

async function shutdown(context: McpContext, server: McpServer): Promise<void> {
  context.logger.info('Shutting down; aborting active runs.');
  await context.runManager.shutdown();
  await server.close().catch(() => undefined);
  process.exit(0);
}

function parseArgs(argv: string[]): McpArgs {
  let transport = 'stdio';
  let envFile: string | undefined;
  let dataDir: string | undefined;
  let noEnv = false;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const [name, inlineValue] = splitFlag(token);
    const value = inlineValue ?? argv[index + 1];

    switch (name) {
      case '--transport':
        transport = requireValue(name, value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--env-file':
        envFile = requireValue(name, value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--data-dir':
        dataDir = requireValue(name, value);
        if (inlineValue === undefined) index += 1;
        break;
      case '--no-env':
        noEnv = true;
        break;
      case '--version':
        version = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`Unknown argument "${token}".`);
    }
  }

  if (transport !== 'stdio') {
    throw new Error(`Unsupported transport "${transport}". This release supports stdio only.`);
  }
  return { transport, envFile, dataDir, noEnv, help, version };
}

function parseInitArgs(argv: string[]): { envFile?: string; help: boolean } {
  let envFile: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const [name, inlineValue] = splitFlag(token);

    switch (name) {
      case '--env-file':
        envFile = requireValue(name, inlineValue ?? argv[index + 1]);
        if (inlineValue === undefined) index += 1;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`Unknown argument "${token}" for init.`);
    }
  }
  return { envFile, help };
}

function parseSettingsArgs(argv: string[]): { envFile?: string; allow?: string; deny?: string; json: boolean; help: boolean } {
  const parsed: { envFile?: string; allow?: string; deny?: string; json: boolean; help: boolean } = { json: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const [name, inlineValue] = splitFlag(token);
    const valued = { '--env-file': 'envFile', '--allow': 'allow', '--deny': 'deny' } as const;

    if (name in valued) {
      parsed[valued[name as keyof typeof valued]] = requireValue(name, inlineValue ?? argv[index + 1]);
      if (inlineValue === undefined) index += 1;
    } else if (name === '--json') {
      parsed.json = true;
    } else if (name === '--help' || name === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument "${token}" for settings.`);
    }
  }
  return parsed;
}

function splitFlag(token: string): [string, string | undefined] {
  const equals = token.indexOf('=');
  return equals === -1 ? [token, undefined] : [token.slice(0, equals), token.slice(equals + 1)];
}

function requireValue(name: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`[leafi-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
