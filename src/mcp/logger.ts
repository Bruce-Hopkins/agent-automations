export interface McpLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/** MCP uses stdout for JSON-RPC, so every log line belongs on stderr. */
export function createStderrLogger(): McpLogger {
  return {
    info: (message) => process.stderr.write(`[leafi-mcp] ${message}\n`),
    warn: (message) => process.stderr.write(`[leafi-mcp] warning: ${message}\n`),
    error: (message, error) => {
      const detail = error instanceof Error ? `: ${error.message}` : error === undefined ? '' : `: ${String(error)}`;
      process.stderr.write(`[leafi-mcp] error: ${message}${detail}\n`);
    },
  };
}
