/**
 * @guppy/mcp — external tool servers for the agent loop.
 *
 * `guppy mcp add <name> --command ...` registers a stdio MCP server; at run
 * time `connectMcpServers` spawns the registered servers, lists their tools,
 * and exposes them to the core loop as `server__tool` GuppyTools.
 */

export type {
  McpServerConfig,
  McpConfig,
} from './config.js';
export {
  defaultMcpConfigPath,
  loadMcpConfig,
  saveMcpConfig,
  addMcpServer,
  removeMcpServer,
} from './config.js';
export type {
  McpBridge,
  McpBridgeOptions,
} from './bridge.js';
export {
  connectMcpServers,
  MCP_TOOL_SEPARATOR,
} from './bridge.js';
