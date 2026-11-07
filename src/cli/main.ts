import { FlowService, FlowError } from '../app/flow-service';
import { PreflightError } from '../app/preflight';
import { RunService } from '../app/run-service';
import { disableImplicitTracing, loadEnvironment } from '../config/env';
import { RuntimeConfig } from '../config/runtime-config';
import { EmailService } from '../email/email-service';
import { ModelFactory } from '../providers/model-factory';
import { ProviderService } from '../providers/provider-service';
import { FlowFormatError } from '../runtime/flow-payload';
import { RunExecutor } from '../runtime/run-executor';
import { RunStore } from '../runtime/run-store';
import { VERSION } from '../version';
import {
  commandHelp,
  EXIT,
  globalHelp,
  parseArgv,
  UsageError,
  type ExitCode,
  type ParsedArgs,
} from './args';
import type { CommandContext } from './context';
import { runGraph } from './graph';
import { runInit } from './init';
import { runProviders } from './providers';
import { runRun } from './run';
import { runRuns } from './runs';
import { runSchema } from './schema';
import { runSettingsCommand } from './settings';
import { runValidate } from './validate';

/**
 * The commands that work on flows. The installed server.mjs hands these to the
 * CLI, so the one downloaded file is also the leafi command;
 * init and settings stay the server's own.
 */
export const FLOW_COMMANDS = ['validate', 'schema', 'run', 'graph', 'providers', 'runs'] as const;

/** Runs the CLI on these arguments and sets process.exitCode; it never throws. */
export async function runCli(argv: string[]): Promise<void> {
  try {
    process.exitCode = await dispatch(parseArgv(argv));
  } catch (error) {
    process.exitCode = reportError(error, argv);
  }
}

/** Whether these arguments name one of the flow commands. */
export function isFlowCommand(argv: string[]): boolean {
  const named = (token: string | undefined) => (FLOW_COMMANDS as readonly string[]).includes(token ?? '');
  try {
    return named(parseArgv(argv).command);
  } catch {
    // A malformed flag still goes to the CLI when a flow command is named, so
    // the person gets the CLI's usage error rather than the server's.
    return argv.some(named);
  }
}

async function dispatch(parsed: ParsedArgs): Promise<ExitCode> {
  if (parsed.flags.version === true && parsed.command === undefined) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.success;
  }
  if (parsed.flags.help === true) {
    process.stdout.write(commandHelp(parsed.command));
    return EXIT.success;
  }

  if (parsed.command === undefined) {
    process.stderr.write(`No command given.\n\n${globalHelp()}`);
    return EXIT.usage;
  }

  loadEnvironment({ envFile: readFlag(parsed, 'env-file'), dataDir: readFlag(parsed, 'data-dir') });
  disableImplicitTracing();
  const context = buildContext(parsed);

  switch (parsed.command) {
    case 'init':
      return runInit(parsed);
    case 'validate':
      return runValidate(parsed, context);
    case 'schema':
      return runSchema(parsed);
    case 'run':
      return runRun(parsed, context);
    case 'graph':
      return runGraph(parsed, context);
    case 'providers':
      return runProviders(parsed, context);
    case 'runs':
      return runRuns(parsed, context);
    case 'settings':
      return runSettingsCommand(parsed);
    default:
      throw new UsageError(`Unknown command "${parsed.command}".`);
  }
}

function buildContext(parsed: ParsedArgs): CommandContext {
  const config = new RuntimeConfig({ dataDir: readFlag(parsed, 'data-dir') });
  const store = new RunStore(config);
  const email = new EmailService(config);
  const executor = new RunExecutor(config, store, new ModelFactory(config), email, {
    info: () => undefined,
    error: (message) => process.stderr.write(`${message}\n`),
  });

  return {
    config,
    flows: new FlowService(),
    runs: new RunService(config, store, executor, email),
    store,
    providers: new ProviderService(config),
  };
}

function readFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function reportError(error: unknown, argv: string[]): ExitCode {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${commandHelp(namedCommand(argv))}`);
    return EXIT.usage;
  }
  if (error instanceof FlowError || error instanceof FlowFormatError) {
    process.stderr.write(`${error.message}\n`);
    return EXIT.invalidInput;
  }
  if (error instanceof PreflightError) {
    process.stderr.write(`${error.message}\n`);
    return error.exitCode;
  }
  process.stderr.write(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
  return EXIT.runFailed;
}

function namedCommand(argv: string[]): string | undefined {
  const [command] = argv;
  return command && !command.startsWith('-') ? command : undefined;
}
