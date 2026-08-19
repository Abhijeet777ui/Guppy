/**
 * MCP server config (`~/.guppy/mcp.json`).
 *
 * Mirrors the per-user config pattern from `@guppy/models` (user-config.ts):
 * plaintext JSON behind a best-effort 0600 file mode, degrading to an empty
 * config on any read error so a corrupt file can never brick the CLI.
 *
 * A server is a stdio subprocess: `command` + `args` (plus optional extra
 * env). These are user-registered capabilities — the book's own rule applies:
 * a tool that runs with your permissions is a vector, and MCP servers are
 * explicitly opt-in for exactly that reason.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A registered MCP server, launched over stdio. */
export interface McpServerConfig {
  /** Executable to spawn (e.g. `npx`, `node`, or a path). */
  command: string;
  /** Arguments to the executable (e.g. `["-y", "@modelcontextprotocol/server-fetch"]`). */
  args?: string[];
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
}

/** The config file shape: `{ "mcpServers": { "<name>": { command, args } } }`. */
export interface McpConfig {
  version?: number;
  mcpServers: Record<string, McpServerConfig>;
}

/** Where `guppy mcp` reads and writes registered servers. */
export function defaultMcpConfigPath(): string {
  return process.env['GUPPY_MCP_CONFIG'] ?? join(homedir(), '.guppy', 'mcp.json');
}

/** Load the MCP config; a missing or corrupt file degrades to empty. */
export function loadMcpConfig(path = defaultMcpConfigPath()): McpConfig {
  try {
    if (!existsSync(path)) return { mcpServers: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<McpConfig>;
    return {
      mcpServers:
        parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {},
    };
  } catch {
    return { mcpServers: {} };
  }
}

/** Persist the config (0600, same trade-off as API keys). */
export function saveMcpConfig(config: McpConfig, path = defaultMcpConfigPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/** Add (or replace) a server by name and persist. Returns the new config. */
export function addMcpServer(
  name: string,
  server: McpServerConfig,
  path = defaultMcpConfigPath(),
): McpConfig {
  const config = loadMcpConfig(path);
  config.mcpServers[name] = server;
  saveMcpConfig(config, path);
  return config;
}

/** Remove a server by name and persist. Returns the new config. */
export function removeMcpServer(name: string, path = defaultMcpConfigPath()): McpConfig {
  const config = loadMcpConfig(path);
  delete config.mcpServers[name];
  saveMcpConfig(config, path);
  return config;
}
