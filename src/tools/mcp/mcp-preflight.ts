import type { AgentNode } from '../../domain/types';
import { listMcpTools } from './mcp-toolkit';

export interface McpPreflightOptions {
  command: string;
  dataDir: string;
  timeoutMs: number;
  allowlist: readonly string[];
}

/**
 * Starts the MCP server once and checks the tools the flow expects are there.
 * A flow whose nodes hold the mcp permission fails before its first token when
 * the launcher cannot bring the server (and, by default, its browser) up.
 */
export async function mcpPreflight(
  nodes: readonly AgentNode[],
  options: McpPreflightOptions,
): Promise<string[]> {
  const needing = nodes.filter((node) => node.permissions.mcp);
  if (needing.length === 0) {
    return [];
  }

  const labels = needing.map((node) => `"${node.label}"`).join(', ');
  const repair = `Set LEAFI_MCP_COMMAND in the environment to an MCP server launcher, such as chrome-devtools-mcp for a browser (current: ${options.command}).`;

  try {
    const tools = await listMcpTools({
      command: options.command,
      dataDir: options.dataDir,
      timeoutMs: options.timeoutMs,
    });
    const offered = new Set(tools.map((tool) => tool.name));
    if (!options.allowlist.some((name) => offered.has(name))) {
      const available = tools.map((tool) => tool.name).join(', ');
      return [
        `${labels} need the MCP server, but it offers none of the tools they may use (${options.allowlist.join(', ')}). Set LEAFI_MCP_TOOLS to a subset of: ${available}.`,
      ];
    }
    return [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`${labels} need the MCP server, but it could not start. ${reason}\n${repair}`];
  }
}
