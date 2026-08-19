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

/**
 * Validate a registration before it is persisted. A typo here (empty name,
 * spaces in a name, an empty command) silently registers a server that breaks
 * later at run time — the `guppy mcp add` dogfooding finding. Throw early so
 * the caller can surface a readable error instead.
 */
export function validateMcpServerRegistration(name: string, server: McpServerConfig): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('MCP server name must not be empty');
  }
  // Names are used as config keys and CLI arguments (`guppy mcp remove <name>`
  // is position-based) — spaces and shell-hostile characters break both.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `Invalid MCP server name "${name}": use letters, digits, dash, underscore, or dot (no spaces)`,
    );
  }
  if (typeof server.command !== 'string' || server.command.trim() === '') {
    throw new Error(`MCP server "${name}" must have a command (e.g. npx, node, or a path)`);
  }
}

/**
 * Add a server by name and persist. Returns the new config.
 *
 * Refuses to silently overwrite an existing name unless `force` is set (the
 * same rule `guppy skill install` applies): re-adding a name should be an
 * explicit act, not an accidental clobber.
 */
export function addMcpServer(
  name: string,
  server: McpServerConfig,
  path = defaultMcpConfigPath(),
  options: { force?: boolean } = {},
): McpConfig {
  validateMcpServerRegistration(name, server);
  const config = loadMcpConfig(path);
  if (config.mcpServers[name] && !options.force) {
    throw new Error(`MCP server "${name}" is already registered — pass --force to overwrite it`);
  }
  config.mcpServers[name] = { ...server, command: server.command.trim() };
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
