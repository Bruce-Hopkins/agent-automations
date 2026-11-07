import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { childEnvironment } from '../environment';
import { killProcessTree, OWN_PROCESS_GROUP } from '../process-tree';
import { VERSION } from '../../version';

/** A JSON Schema fragment, as an MCP server reports a tool's inputs. */
export type McpJsonSchema = Record<string, unknown>;

/** One tool an MCP server offers, before it is bound to a model. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
}

export interface McpClientOptions {
  /** Launcher command, e.g. `npx -y chrome-devtools-mcp@1.10.1 --headless --isolated`. */
  command: string;
  /** The data directory; the server's private home is `<dataDir>/mcp-home`. */
  dataDir: string;
  /** Budget for the whole handshake and for any single tool call. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Defaults to an allowlist environment with a private home for the server. */
  env?: NodeJS.ProcessEnv;
}

export interface McpClient {
  readonly tools: McpToolInfo[];
  /** Runs a tool and returns its text content. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** Stops the server process. Safe to call more than once. */
  close(): Promise<void>;
}

const JSONRPC_VERSION = '2.0';
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'leafi', version: VERSION };
const STDERR_TAIL_CHARS = 2000;
const CLOSE_GRACE_MS = 3000;

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingCall {
  resolve: (message: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Connects to an MCP server over stdio: one JSON-RPC message per line, both
 * directions. The handshake, the tool list and every call share one child
 * process, so a node pays the server's start-up cost once.
 */
export async function connectMcpClient(options: McpClientOptions): Promise<McpClient> {
  const client = new StdioMcpClient(options, options.env ?? (await serverEnvironment(options.dataDir)));
  await client.connect();
  return client;
}

/**
 * A server started for one flow gets a filtered environment and its own home, so
 * it can install and cache what it needs without seeing host credentials or
 * writing into the user's home directory.
 */
async function serverEnvironment(dataDir: string): Promise<NodeJS.ProcessEnv> {
  const home = await privateHome(path.join(dataDir, 'mcp-home'));
  return childEnvironment({ home });
}

/**
 * The server's home holds its npm config and cache, so whoever controls it
 * controls what `npx` runs. It is created owner-only, and refused when it
 * belongs to someone else or is open to other accounts.
 */
export async function privateHome(home: string): Promise<string> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const stats = await fs.lstat(home);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`Refusing to use ${home} as the MCP server's home: it is not a directory owned by this user.`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(
        `Refusing to use ${home} as the MCP server's home: other accounts can access it. Run "chmod 700 ${home}" if it is yours.`,
      );
    }
  }
  await fs.mkdir(path.join(home, 'tmp'), { recursive: true, mode: 0o700 });
  return home;
}

class StdioMcpClient implements McpClient {
  readonly tools: McpToolInfo[] = [];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private readonly options: McpClientOptions;
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private closed = false;

  constructor(
    options: McpClientOptions,
    env: NodeJS.ProcessEnv,
  ) {
    this.options = options;
    const { command, args } = splitCommand(options.command);
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      // Its own process group, so closing it also stops anything it launched, such as a browser.
      detached: OWN_PROCESS_GROUP,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.child.on('error', (error) => this.fail(`The MCP server could not start: ${error.message}`));
    this.child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.fail(`The MCP server exited (${reason}).${this.stderrTail()}`);
    });
    options.signal?.addEventListener('abort', () => void this.close(), { once: true });
  }

  async connect(): Promise<void> {
    const initialized = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (initialized.error) {
      throw new Error(`The MCP server rejected the handshake: ${initialized.error.message}`);
    }
    this.send({ jsonrpc: JSONRPC_VERSION, method: 'notifications/initialized' });

    const listed = await this.request('tools/list', {});
    const tools = isRecord(listed.result) ? listed.result.tools : undefined;
    if (!Array.isArray(tools)) {
      throw new Error('The MCP server returned no tool list.');
    }
    for (const candidate of tools) {
      const tool = readTool(candidate);
      if (tool) {
        this.tools.push(tool);
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) {
      throw new Error(`MCP tool "${name}" failed: ${response.error.message}`);
    }
    return readContent(response.result);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPending('The MCP server was closed.');
    this.child.stdin.end();
    killProcessTree(this.child, 'SIGTERM');
    // Anything that ignores SIGTERM is killed once the server has had time to stop what it launched.
    setTimeout(() => killProcessTree(this.child, 'SIGKILL'), CLOSE_GRACE_MS).unref();
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (this.closed) {
      return Promise.reject(new Error('The MCP server is closed.'));
    }
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The MCP server did not answer "${method}" within ${this.options.timeoutMs}ms.${this.stderrTail()}`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: JSONRPC_VERSION, id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this.dispatch(line);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse & { method?: string };
    try {
      message = JSON.parse(line) as JsonRpcResponse & { method?: string };
    } catch {
      return;
    }

    if (message.method !== undefined) {
      this.answer(message);
      return;
    }
    const call = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!call) {
      return;
    }
    clearTimeout(call.timer);
    this.pending.delete(message.id as number);
    call.resolve(message);
  }

  /** Servers may ask the client for roots or ping it; both get a harmless answer. */
  private answer(message: JsonRpcResponse & { method?: string }): void {
    if (message.id === undefined) {
      return;
    }
    const result = message.method === 'roots/list' ? { roots: [] } : {};
    this.send({ jsonrpc: JSONRPC_VERSION, id: message.id, result });
  }

  private fail(reason: string): void {
    this.closed = true;
    this.rejectPending(reason);
  }

  private rejectPending(reason: string): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      this.pending.delete(id);
      call.reject(new Error(reason));
    }
  }

  private stderrTail(): string {
    const tail = this.stderr.trim();
    return tail.length > 0 ? `\n${tail}` : '';
  }
}

function readTool(candidate: unknown): McpToolInfo | undefined {
  if (!isRecord(candidate) || typeof candidate.name !== 'string') {
    return undefined;
  }
  return {
    name: candidate.name,
    description: typeof candidate.description === 'string' ? candidate.description : '',
    inputSchema: isRecord(candidate.inputSchema) ? candidate.inputSchema : {},
  };
}

function readContent(result: unknown): string {
  if (!isRecord(result)) {
    return '';
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((item) => {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }
    return '[non-text content omitted]';
  });
  const text = parts.join('\n').trim();
  return result.isError === true ? `Error: ${text}` : text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Splits a launcher command the way a shell would for simple, unquoted arguments. */
export function splitCommand(command: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(command);
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    match = pattern.exec(command);
  }
  const [first = '', ...rest] = tokens;
  return { command: first, args: rest };
}
