import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FLOW_SCHEMA } from '../../app/flow-schema';

export function registerFlowSchemaResource(server: McpServer): void {
  server.registerResource(
    'flow-schema',
    'leafi://schema/flow',
    {
      title: 'Flow JSON Schema',
      description: 'The contract for a leafi flow document.',
      mimeType: 'application/schema+json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: JSON.stringify(FLOW_SCHEMA, null, 2) }],
    }),
  );
}
