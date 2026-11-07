import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetch, type Response } from 'undici';
import { z } from 'zod';
import type { AgentNode } from '../domain/types';
import { childEnvironment } from './environment';
import { htmlToText, requireString } from './text';
import { pieceEnd, readerFor, ToolOutput } from './tool-output';
import type { EmailToolkit } from './email/email-toolkit';
import type { McpToolkit } from './mcp/mcp-toolkit';
import { duration, groupAlive, type NodeJobs } from './jobs';
import { killProcessTree, OWN_PROCESS_GROUP } from './process-tree';
import { assertPublicHost, BlockedAddressError, publicWebDispatcher } from './public-address';
import { Workspace } from './workspace';
import { VERSION } from '../version';

export const COMPLETE_TASK_TOOL = 'complete_task';

const DENIED_COMMANDS = new Set(['sudo', 'su', 'doas']);
const SHELL_SEPARATORS = /[\s;&|(){}<>`$=]+/;
const WEB_FETCH_USER_AGENT = `leafi/${VERSION} (local agent runtime)`;
const MAX_REDIRECTS = 3;

export interface ToolLimits {
  /** How long a shell command runs when it does not ask for longer. */
  bashTimeoutMs: number;
  /** The most a shell command may ask for with `timeoutSeconds`; defaults to `bashTimeoutMs`. */
  bashTimeoutMaxMs?: number;
  outputLimitBytes: number;
  /** The most an oversized result saved to the workspace may hold. */
  outputSaveLimitBytes: number;
  /** The most all tool results of one model response may return together. */
  outputStepLimitBytes?: number;
  webFetchTimeoutMs: number;
  webFetchLimitBytes: number;
}

export interface NodeToolkit {
  /** Tool schemas bound to the model, including the `complete_task` terminator. */
  schemas: StructuredToolInterface[];
  /** Runs one non-terminating tool call and returns text for the model to observe. */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface NodeToolkitOptions {
  node: AgentNode;
  workspace: Workspace;
  limits: ToolLimits;
  signal: AbortSignal;
  /** The node's mailbox tools, present only when it holds the email permission. */
  email?: EmailToolkit;
  /** The node's MCP server tools, present only when it holds the mcp permission. */
  mcp?: McpToolkit;
  /** Shared with the node's mail and MCP tools, so every result obeys one budget. */
  output?: ToolOutput;
  /** The run's background jobs this node can see; without it, `run_bash` has no background mode. */
  jobs?: NodeJobs;
}

export function createNodeToolkit({ node, workspace, limits, signal, email, mcp, output: shared, jobs }: NodeToolkitOptions): NodeToolkit {
  const output = shared ?? createToolOutput(node, workspace, limits);
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  if (node.permissions.read) {
    handlers.set('read_file', (args) => readFileTool(workspace, args, output));
  }
  if (node.permissions.write) {
    handlers.set('write_file', (args) => writeFileTool(workspace, args));
  }
  if (node.permissions.bash) {
    handlers.set('run_bash', (args) => runBashTool(workspace, args, limits, output, signal, jobs));
    if (jobs) {
      handlers.set('job_status', (args) => jobStatusTool(jobs, args, output));
      handlers.set('wait_job', (args) => waitJobTool(jobs, args, output, signal));
      handlers.set('stop_job', (args) => stopJobTool(jobs, args));
    }
  }
  if (node.permissions.web) {
    handlers.set('web_fetch', (args) => webFetchTool(args, limits, output, signal));
  }

  const schemas = [
    completeTaskTool(node),
    ...permittedToolSchemas(node, output, limits, jobs),
    ...(email?.schemas ?? []),
    ...(mcp?.schemas ?? []),
  ];

  return {
    schemas,
    async execute(name, args) {
      const handler = handlers.get(name);
      if (!handler) {
        const emailResult = await email?.execute(name, args);
        if (emailResult !== undefined) {
          return emailResult;
        }
        const mcpResult = await mcp?.execute(name, args);
        if (mcpResult !== undefined) {
          return mcpResult;
        }
        return `Error: "${name}" is not available to this agent.`;
      }
      try {
        return await handler(args);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/** One node's output budget, built from the run's limits and the node's own tools. */
export function createToolOutput(node: AgentNode, workspace: Workspace, limits: ToolLimits): ToolOutput {
  return new ToolOutput({
    workspace,
    nodeId: node.id,
    limitBytes: limits.outputLimitBytes,
    saveLimitBytes: limits.outputSaveLimitBytes,
    reader: readerFor(node.permissions),
    ...(limits.outputStepLimitBytes ? { stepLimitBytes: limits.outputStepLimitBytes } : {}),
  });
}

function completeTaskTool(node: AgentNode): StructuredToolInterface {
  const finishing =
    node.audience === 'person'
      ? 'Finish this node. Call this exactly once, and only when the task is done. The output is the run\'s final result, read by a person.'
      : 'Finish this node. Call this exactly once, and only when the stated condition for completion is met. The output is the single result every downstream node will see.';
  return tool(async () => 'complete_task is handled by the runtime.', {
    name: COMPLETE_TASK_TOOL,
    description: finishing,
    schema: z.object({
      output: z.string().describe('The node result, self-contained: whoever receives it sees only this.'),
      next: z
        .string()
        .optional()
        .describe('When this node has several outgoing branches, the name of the branch whose condition applies.'),
    }),
  });
}

function permittedToolSchemas(
  node: AgentNode,
  output: ToolOutput,
  limits: ToolLimits,
  jobs: NodeJobs | undefined,
): StructuredToolInterface[] {
  const schemas: StructuredToolInterface[] = [];

  if (node.permissions.read) {
    schemas.push(
      tool(async () => '', {
        name: 'read_file',
        description:
          `Read a UTF-8 text file from the run workspace, at most ${output.limitBytes} bytes per call. ` +
          'For a longer file, pass offset to read the next piece; each piece says where the next one starts.',
        schema: z.object({
          path: z.string().describe('File path, relative to the workspace root.'),
          offset: z.number().optional().describe('Byte to start reading at (default 0).'),
          length: z
            .number()
            .optional()
            .describe(`Bytes to read (default and maximum ${output.limitBytes}).`),
        }),
      }),
    );
  }

  if (node.permissions.write) {
    schemas.push(
      tool(async () => '', {
        name: 'write_file',
        description: 'Write a UTF-8 text file inside the run workspace, creating parent directories as needed.',
        schema: z.object({
          path: z.string().describe('File path, relative to the workspace root.'),
          content: z.string().describe('Full contents to write.'),
        }),
      }),
    );
  }

  if (node.permissions.bash) {
    const maxSeconds = Math.round(maxBashTimeout(limits) / 1000);
    const background = jobs
      ? `For anything that takes longer (a crawl, a build, a long download), pass background: true: it returns at once with a job id, ` +
        `and wait_job then waits for it in a single call, so never poll with sleep. ` +
        `A job still running when you call complete_task is handed to the next node. `
      : '';
    schemas.push(
      tool(async () => '', {
        name: 'run_bash',
        description:
          'Run a shell command with the run workspace as the working directory. ' +
          `It is killed, with everything it started, after ${Math.round(limits.bashTimeoutMs / 1000)}s, ` +
          `or after timeoutSeconds when you pass it (at most ${maxSeconds}s). ` +
          background +
          'Commands that name sudo, su or doas are rejected. ' +
          output.describe(),
        schema: z.object({
          command: z.string().describe('The shell command to run.'),
          timeoutSeconds: z
            .number()
            .optional()
            .describe(
              jobs
                ? `Seconds before the command is killed (default ${Math.round(limits.bashTimeoutMs / 1000)}, at most ${maxSeconds}); with background: true, the job's deadline (at most ${Math.round(jobs.registry.timeoutMs / 1000)}).`
                : `Seconds before the command is killed (default ${Math.round(limits.bashTimeoutMs / 1000)}, at most ${maxSeconds}).`,
            ),
          ...(jobs
            ? {
                background: z
                  .boolean()
                  .optional()
                  .describe('Run the command as a background job: return its job id at once, its output going to a log file.'),
              }
            : {}),
        }),
      }),
    );
    if (jobs) {
      schemas.push(...jobSchemas());
    }
  }

  if (node.permissions.web) {
    schemas.push(
      tool(async () => '', {
        name: 'web_fetch',
        description:
          'Fetch a public web page over http(s) and return its readable text. ' +
          'Local and private network addresses are rejected, the download is capped, and the request times out. ' +
          output.describe(),
        schema: z.object({ url: z.string().describe('Absolute http(s) URL to read.') }),
      }),
    );
  }

  return schemas;
}

/**
 * Reads one piece of a file, at most the output budget long. A file that fits
 * comes back as-is; otherwise the piece starts with a note naming the next offset,
 * so the model reads on deliberately instead of guessing.
 */
async function readFileTool(workspace: Workspace, args: Record<string, unknown>, output: ToolOutput): Promise<string> {
  const target = requireString(args, 'path');
  const offset = optionalByteCount(args, 'offset', 0);
  const length = Math.min(optionalByteCount(args, 'length', output.limitBytes) || output.limitBytes, output.limitBytes);
  const resolved = await workspace.resolve(target);

  const handle = await fs.open(resolved, 'r');
  try {
    const { size } = await handle.stat();
    if (offset > 0 && offset >= size) {
      return `[${target} is ${size} bytes; offset ${offset} is past the end]`;
    }
    // Four bytes past the piece are enough to snap both of its ends to whole characters.
    const buffer = Buffer.alloc(Math.min(size - offset, length + 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
    const window = buffer.subarray(0, bytesRead);

    let start = 0;
    while (start < 3 && ((window[start] ?? 0) & 0xc0) === 0x80) {
      start += 1;
    }
    const end = pieceEnd(window, start, length);
    const first = offset + start;
    const last = offset + end;
    const text = window.subarray(start, end).toString('utf8');
    if (first === 0 && last === size) {
      return text;
    }
    const next = last < size ? `continue with offset=${last}` : 'end of file';
    return `[${target}: bytes ${first}-${last} of ${size}; ${next}]\n${text}`;
  } finally {
    await handle.close();
  }
}

function optionalByteCount(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`"${key}" must be a whole number of bytes, 0 or more.`);
  }
  return parsed;
}

async function writeFileTool(workspace: Workspace, args: Record<string, unknown>): Promise<string> {
  const target = requireString(args, 'path');
  const content = requireString(args, 'content', { allowEmpty: true });
  const resolved = await workspace.resolve(target);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, 'utf8');
  return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${target}.`;
}

async function runBashTool(
  workspace: Workspace,
  args: Record<string, unknown>,
  limits: ToolLimits,
  output: ToolOutput,
  signal: AbortSignal,
  jobs?: NodeJobs,
): Promise<string> {
  const command = requireString(args, 'command');
  assertAllowedCommand(command);
  const seconds = optionalSeconds(args, 'timeoutSeconds');

  if (args.background === true || args.background === 'true') {
    if (!jobs) {
      throw new Error('Background jobs are not available here; run the command in the foreground.');
    }
    const job = await jobs.start(command, seconds === undefined ? undefined : seconds * 1000);
    return [
      `Started ${job.id} in the background; it is killed in ${duration(Date.parse(job.deadline) - Date.parse(job.startedAt))} if still running.`,
      `Its output goes to ${job.log}.`,
      `Call wait_job to wait for it (one call waits until it ends), job_status to check on it, or stop_job to end it.`,
      'If you call complete_task while it runs, it is handed to the next node.',
    ].join('\n');
  }

  const timeoutMs = Math.min(seconds === undefined ? limits.bashTimeoutMs : seconds * 1000, maxBashTimeout(limits));
  // Collect past the cap only when the overflow can be saved for the node to read.
  const collectLimit = output.saving ? output.saveLimitBytes : output.limitBytes;
  const home = workspace.root;
  await fs.mkdir(path.join(home, 'tmp'), { recursive: true });

  return new Promise<string>((resolve) => {
    const child = spawn(command, {
      cwd: home,
      shell: process.platform === 'win32' ? true : '/bin/bash',
      env: childEnvironment({ home }),
      // Its own process group, so a timeout reaches `cmd &` and every pipeline stage.
      detached: OWN_PROCESS_GROUP,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // The true end of each stream, kept even after collection stops, because errors come last.
    const stdoutEnd = new StreamEnd(output.limitBytes);
    const stderrEnd = new StreamEnd(output.limitBytes);
    let collected = 0;
    let overflowed = false;
    let timedOut = false;

    const capture = (chunk: Buffer, into: Buffer[]): void => {
      const room = collectLimit - collected;
      if (chunk.byteLength > room) {
        overflowed = true;
      }
      if (room > 0) {
        const kept = chunk.subarray(0, room);
        into.push(kept);
        collected += kept.byteLength;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      capture(chunk, stdout);
      stdoutEnd.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      capture(chunk, stderr);
      stderrEnd.push(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGKILL');
    }, timeoutMs);
    const onAbort = () => killProcessTree(child, 'SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (result: string): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    if (signal.aborted) {
      onAbort();
    }

    child.on('error', (error) => settle(`Error: ${error.message}`));

    child.on('close', (code) => {
      if (signal.aborted) {
        settle('Error: the command was cancelled.');
        return;
      }
      const after = timeoutMs < 1000 ? `${timeoutMs}ms` : duration(timeoutMs);
      const killed = jobs
        ? `Killed after ${after}: the command did not finish in time. For a long command, pass a larger timeoutSeconds (at most ${Math.round(maxBashTimeout(limits) / 1000)}) or background: true.`
        : `Killed after ${after}: the command did not finish in time.`;
      // Whatever the command left running (`cmd &`, nohup) becomes a job, so it is tracked and handed on.
      const left = !timedOut && jobs && child.pid !== undefined && OWN_PROCESS_GROUP && groupAlive(child.pid);
      const kept = left && child.pid !== undefined ? jobs.adopt(child.pid, command) : undefined;
      const status = [
        timedOut ? killed : `Exit code: ${code ?? 'unknown'}`,
        ...(kept
          ? [
              `[This command left processes running in the background; they are now ${kept.id}, killed in ${duration(Date.parse(kept.deadline) - Date.now())} if still running. ` +
                'Use wait_job, job_status or stop_job on it. Their output was not captured; next time pass background: true so it goes to a log.]',
            ]
          : []),
      ].join('\n');
      const raw = Buffer.concat([...stdout, ...stderr]).toString('utf8');
      // Trailing blank lines are noise, but an overflowed result is saved exactly as collected.
      const text = overflowed ? raw : raw.trimEnd();
      if (text.length === 0) {
        settle(`${status}\n(no output)`);
        return;
      }
      const ending = overflowed
        ? Buffer.concat([stdoutEnd.bytes(), stderrEnd.bytes()]).subarray(-output.limitBytes)
        : undefined;
      output.cap('run_bash', text, { overflowed, keepEnd: true, ...(ending ? { ending } : {}) }).then(
        (body) => settle(`${status}\n${body}`),
        (error: unknown) => settle(`${status}\nError: could not save the output: ${error instanceof Error ? error.message : String(error)}`),
      );
    });
  });
}

function maxBashTimeout(limits: ToolLimits): number {
  return Math.max(limits.bashTimeoutMaxMs ?? limits.bashTimeoutMs, limits.bashTimeoutMs);
}

function optionalSeconds(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`"${key}" must be a number of seconds, more than 0.`);
  }
  return parsed;
}

function jobSchemas(): StructuredToolInterface[] {
  const ids = z
    .array(z.string())
    .optional()
    .describe('Job ids, such as "job-1". Leave out for every job you hold.');
  return [
    tool(async () => '', {
      name: 'job_status',
      description: 'Show how your background jobs stand, with the end of each one\'s log. Returns at once.',
      schema: z.object({ ids }),
    }),
    tool(async () => '', {
      name: 'wait_job',
      description:
        'Wait until background jobs end, in one call, then show how each ended with the end of its log. ' +
        'Waits until every listed job has ended, `seconds` have passed, or the job deadlines or the run\'s time limit arrive, whichever is first. ' +
        'Waiting costs one model call however long it takes, so use it instead of polling with sleep.',
      schema: z.object({
        ids,
        seconds: z.number().optional().describe('The most to wait. Leave out to wait until the jobs end.'),
      }),
    }),
    tool(async () => '', {
      name: 'stop_job',
      description: 'Kill a background job, with everything it started.',
      schema: z.object({ id: z.string().describe('The job id, such as "job-1".') }),
    }),
  ];
}

/** The jobs a tool call names, all of them held by this node; none named means every one it holds. */
function heldJobs(jobs: NodeJobs, args: Record<string, unknown>): string[] {
  const named = args.ids;
  if (named === undefined || named === null || (Array.isArray(named) && named.length === 0)) {
    return jobs.ids();
  }
  const ids = Array.isArray(named) ? named.map(String) : [String(named)];
  const unknown = ids.filter((id) => !jobs.holds(id));
  if (unknown.length > 0) {
    const held = jobs.ids();
    throw new Error(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not among your jobs. You hold: ${held.length > 0 ? held.join(', ') : 'none'}.`);
  }
  return ids;
}

/** Each job's line and the end of its log, sharing one result's budget. */
async function jobReport(jobs: NodeJobs, ids: string[], output: ToolOutput): Promise<string> {
  if (ids.length === 0) {
    return 'You hold no background jobs.';
  }
  const share = Math.max(512, Math.floor(Math.min(output.limitBytes, 16 * 1024) / ids.length));
  const sections: string[] = [];
  for (const id of ids) {
    const job = jobs.registry.get(id);
    if (!job) {
      continue;
    }
    const tail = await jobs.registry.tail(id, share);
    sections.push(jobs.describe(job) + (tail ? `\nEnd of log:\n${tail}` : job.log ? '\n(log is empty)' : ''));
  }
  return sections.join('\n\n');
}

async function jobStatusTool(jobs: NodeJobs, args: Record<string, unknown>, output: ToolOutput): Promise<string> {
  return jobReport(jobs, heldJobs(jobs, args), output);
}

async function waitJobTool(jobs: NodeJobs, args: Record<string, unknown>, output: ToolOutput, signal: AbortSignal): Promise<string> {
  const ids = heldJobs(jobs, args);
  if (ids.length === 0) {
    return 'You hold no background jobs.';
  }
  const seconds = optionalSeconds(args, 'seconds');
  const running = ids.map((id) => jobs.registry.get(id)).filter((job) => job?.status === 'running');
  const deadline = Math.max(0, ...running.map((job) => Date.parse(job?.deadline ?? '') - Date.now()));
  const runLeft = jobs.registry.runTimeLeftMs();
  const limit = Math.min(seconds === undefined ? Infinity : seconds * 1000, deadline, runLeft);
  const started = Date.now();
  const ended = await jobs.registry.wait(ids, limit, signal);
  signal.throwIfAborted();
  const waited = duration(Date.now() - started);
  const why = ended
    ? `Waited ${waited}: every job has ended.`
    : limit === runLeft
      ? `Waited ${waited}, up to the run's time limit; some jobs are still running.`
      : `Waited ${waited}; some jobs are still running.`;
  return `${why}\n\n${await jobReport(jobs, ids, output)}`;
}

async function stopJobTool(jobs: NodeJobs, args: Record<string, unknown>): Promise<string> {
  const id = requireString(args, 'id');
  heldJobs(jobs, { ids: [id] });
  const job = jobs.registry.stop(id, jobs.stoppedBy());
  return job ? jobs.describe(job) : `${id} was not found.`;
}

/** The last `limit` bytes written to a stream, however much passed through it. */
class StreamEnd {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    while (this.chunks.length > 1 && this.size - (this.chunks[0]?.byteLength ?? 0) >= this.limit) {
      this.size -= this.chunks.shift()?.byteLength ?? 0;
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks).subarray(-this.limit);
  }
}

/** A speed bump, not a boundary: quoting or indirection (`s''udo`) gets past it. */
function assertAllowedCommand(command: string): void {
  for (const token of command.split(SHELL_SEPARATORS)) {
    const name = path.basename(token).replace(/\.exe$/i, '');
    if (DENIED_COMMANDS.has(name)) {
      throw new Error(`"${name}" is not permitted: privilege escalation is blocked.`);
    }
  }
}

async function webFetchTool(
  args: Record<string, unknown>,
  limits: ToolLimits,
  output: ToolOutput,
  signal: AbortSignal,
): Promise<string> {
  const start = httpUrl(requireString(args, 'url'));
  const response = await fetchFollowingRedirects(start, limits, signal);

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await readCapped(response, limits.webFetchLimitBytes);
  const body = contentType.includes('html') ? htmlToText(raw.text) : raw.text;
  const lines = [
    `URL: ${response.url || start.href}`,
    `Status: ${response.status}${contentType ? ` (${contentType.split(';')[0]})` : ''}`,
  ];
  if (raw.truncated) {
    lines.push(`[download truncated at ${limits.webFetchLimitBytes} bytes]`);
  }
  lines.push('', body ? await output.cap('web_fetch', body) : '(no readable text)');
  return lines.join('\n');
}

async function fetchFollowingRedirects(
  start: URL,
  limits: ToolLimits,
  signal: AbortSignal,
): Promise<Response> {
  let target = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchWithTimeout(target, limits.webFetchTimeoutMs, signal);
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get('location');
    if (!location) {
      return response;
    }
    target = httpUrl(new URL(location, target).href);
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
}

async function fetchWithTimeout(target: URL, timeoutMs: number, signal: AbortSignal): Promise<Response> {
  assertPublicHost(target);
  signal.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(target, {
      dispatcher: publicWebDispatcher,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'user-agent': WEB_FETCH_USER_AGENT,
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(signal.aborted ? 'The fetch was cancelled.' : `The request timed out after ${timeoutMs}ms.`);
    }
    // undici reports every connect failure as "fetch failed"; the refusal is the cause.
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof BlockedAddressError) {
      throw cause;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function readCapped(response: Response, limitBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: await response.text(), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    const remaining = limitBytes - size;
    if (value.byteLength >= remaining) {
      chunks.push(Buffer.from(value.subarray(0, Math.max(0, remaining))));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
    size += value.byteLength;
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function httpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be fetched.');
  }
  return url;
}
