import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EXAMPLE_FLOW } from '../../app/flow-schema';

export function registerExampleResource(server: McpServer): void {
  server.registerResource(
    'example-flow',
    'leafi://examples/example',
    {
      title: 'Runnable example flow',
      description: 'A two-node flow that passes validate_flow.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(EXAMPLE_FLOW, null, 2) }],
    }),
  );
}
