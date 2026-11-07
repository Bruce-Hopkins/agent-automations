import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { McpContext } from './context';
import { withToolErrors } from './errors';
import type { AskPerson } from './permission-request';
import { TOOLS } from './registry';
import { registerResources } from './resources';
import { VERSION } from '../version';

/** How long a question to the person may wait for an answer before it counts as a refusal. */
export const ASK_TIMEOUT_MS = 5 * 60 * 1000;

export function createMcpServer(context: McpContext): McpServer {
  const server = new McpServer({ name: 'leafi', version: VERSION });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: unknown, extra: { requestId: RequestId }) =>
        withToolErrors(() => tool.handle(input as never, context, { ask: askPerson(server, extra.requestId) }), context),
    );
  }

  registerResources(server);
  return server;
}

/**
 * The client's form questions, tied to the tool call that asks, or nothing
 * when the client did not say it can show them. A client that advertises a
 * bare `elicitation: {}` supports forms; the SDK reads it that way.
 */
function askPerson(server: McpServer, requestId: RequestId): AskPerson | undefined {
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    return undefined;
  }
  return (params) => server.server.elicitInput(params, { relatedRequestId: requestId, timeout: ASK_TIMEOUT_MS });
}
