/**
 * Hermetic MCP server for the bridge tests: a real stdio MCP server with
 * three tools (echo, add, fail). Spawned as a child process by the tests
 * exactly the way a user-registered server would be.
 *
 * Written against the low-level `Server` API (setRequestHandler) on purpose:
 * it needs no zod schemas, so the fixture stays hermetic and works across
 * SDK versions without dragging in a second dependency.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'guppy-test-mock', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the given text back',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
    {
      name: 'fail',
      description: 'Always reports an error',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echo: ${args.text}` }] };
    case 'add':
      return { content: [{ type: 'text', text: String(args.a + args.b) }] };
    case 'fail':
      return { content: [{ type: 'text', text: 'boom' }], isError: true };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
});

await server.connect(new StdioServerTransport());
