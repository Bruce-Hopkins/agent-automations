import {
  assertFlags,
  EXIT,
  GLOBAL_FLAGS,
  UsageError,
  type ExitCode,
  type ParsedArgs,
} from './args';
import type { CommandContext } from './context';

export async function runRuns(parsed: ParsedArgs, context: CommandContext): Promise<ExitCode> {
  assertFlags(parsed, [...GLOBAL_FLAGS]);

  const [action, id, ...extra] = parsed.positionals;
  if (extra.length > 0) {
    throw new UsageError(`Unexpected argument "${extra[0]}".`);
  }

  if (action === undefined || action === 'list') {
    const runs = await context.runs.listRuns();
    writeJson(runs);
    return EXIT.success;
  }

  if (action === 'show') {
    if (!id) {
      throw new UsageError('"leafi runs show" needs a run id.');
    }
    const run = await context.runs.getRun(id);
    if (!run) {
      throw new UsageError(`No run with id "${id}".`);
    }
    const events = await context.store.readEvents(id);
    writeJson({ ...run, events });
    return EXIT.success;
  }

  throw new UsageError(`Unknown runs action "${action}". Use "runs" or "runs show <id>".`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
