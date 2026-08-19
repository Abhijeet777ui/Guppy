/**
 * MCP client bridge: registered MCP servers become `GuppyTool[]` entries the
 * core loop can call, exactly like the native tools.
 *
 * Each server is spawned over stdio (the MCP spec's canonical transport) via
 * the official `@modelcontextprotocol/sdk`, its tools are listed at connect
 * time, and every call is forwarded to the server's `tools/call` endpoint.
 * Tool names are prefixed with the server name (`server__tool`) so an MCP
 * server can never shadow a native tool like `read_file` or `search`.
 *
 * Honest containment note: an MCP server is still its own process with the
 * user's account permissions — this is not a jail. What Guppy enforces are
 * the three layers in sandbox.ts: a scrubbed environment (no API keys or
 * tokens cross into the server), a workspace cwd (relative file operations
 * stay in the repo), and a guaranteed tree-kill when the session ends (the
 * server and its whole process tree, on every exit path). The remaining
 * vector — a server deliberately abusing the user's own account — is the
 * registration step's responsibility: `guppy mcp add` is the opt-in gate.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ULID } from '@guppy/contracts';
import type { GuppyTool, ToolDefinition, ToolExecution } from '@guppy/core';
import type { McpConfig } from './config.js';
import {
  collectDescendants,
  forceKill,
  killProcessTree,
  scrubEnv,
  trackMcpProcess,
  untrackMcpProcess,
} from './sandbox.js';

/** Separator between server name and tool name in the exposed tool id. */
export const MCP_TOOL_SEPARATOR = '__';

/** One connected MCP server: its client plus the tools it exposed. */
interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: GuppyTool[];
}

/** The result of connecting the configured servers. */
export interface McpBridge {
  /** All external tools, prefixed per server (`server__tool`). */
  tools: GuppyTool[];
  /** How many servers connected successfully (for diagnostics). */
  connected: number;
  /** How many were configured but failed to connect (skipped, not fatal). */
  failed: number;
  /** Terminate all server processes and release resources. */
  close(): Promise<void>;
}

export interface McpBridgeOptions {
  /** How long (ms) a single tools/call round-trip may take. */
  callTimeoutMs?: number;
  /** Connect timeout (ms) for the initialize handshake. */
  connectTimeoutMs?: number;
  /**
   * Working directory the server processes start in (the workspace).
   * Defaults to `process.cwd()` when omitted.
   */
  cwd?: string;
  /** Diagnostics sink; defaults to no output. */
  log?: (message: string) => void;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Connect every configured server and expose its tools. A server that fails
 * to spawn or handshake is logged and skipped — one broken server must not
 * take down the whole session. Returns a bridge whose `close()` terminates
 * every connected server process.
 */
export async function connectMcpServers(
  config: McpConfig,
  options: McpBridgeOptions = {},
): Promise<McpBridge> {
  const log = options.log ?? (() => {});
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const connected: ConnectedServer[] = [];
  let failed = 0;

  for (const [name, server] of Object.entries(config.mcpServers)) {
    try {
      const entry = await connectOne(name, server, {
        cwd: options.cwd ?? process.cwd(),
        connectTimeoutMs,
        callTimeoutMs,
        log,
      });
      connected.push(entry);
      log(`[mcp] connected "${name}" (${entry.tools.length} tool(s))`);
    } catch (e) {
      failed++;
      // connectOne cleans up its own partial spawn before rethrowing, so a
      // half-initialized server can never orphan a process.
      log(`[mcp] server "${name}" failed to connect: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    tools: connected.flatMap((c) => c.tools),
    connected: connected.length,
    failed,
    async close(): Promise<void> {
      // Sandbox layer 3: kill-on-session-end. Snapshot each server's process
      // tree *before* the SDK close, because once a server dies its children
      // get reparented and a tree walk can no longer find them.
      const snapshots = connected.map((c) => ({
        name: c.name,
        root: c.transport.pid,
        descendants: c.transport.pid === null ? [] : collectDescendants(c.transport.pid),
      }));
      // 1. Force-kill known descendants by pid first: works even if they get
      //    reparented mid-close.
      for (const s of snapshots) for (const pid of s.descendants) forceKill(pid);
      // 2. Windows: tree-kill the root *while it is still alive* — taskkill
      //    /T needs the parent chain intact, and the graceful close below
      //    would destroy it first. POSIX skips this so the direct child gets
      //    a real graceful SIGTERM in step 3.
      if (process.platform === 'win32') {
        for (const s of snapshots) if (s.root !== null) killProcessTree(s.root);
      }
      // 3. Graceful SDK close (stdin EOF → SIGTERM → SIGKILL). A no-op on an
      //    already-killed child; the escalation path still covers the race.
      await Promise.allSettled(connected.map((c) => c.client.close()));
      // 4. POSIX: tree-kill the root and any stragglers spawned since the
      //    snapshot. Windows: already done in step 2.
      for (const s of snapshots) {
        if (s.root === null) continue;
        killProcessTree(s.root);
        untrackMcpProcess(s.root);
      }
      connected.length = 0;
    },
  };
}

/** Connect a single configured server, or throw. Caller owns cleanup on throw. */
async function connectOne(
  name: string,
  server: { command: string; args?: string[]; env?: Record<string, string> },
  options: { cwd: string; connectTimeoutMs: number; callTimeoutMs: number; log: (m: string) => void },
): Promise<ConnectedServer> {
  const client = new Client(
    { name: 'guppy', version: '1.0.0' },
    { capabilities: {} },
  );
  client.onerror = (e) => {
    options.log(`[mcp:${name}] ${e instanceof Error ? e.message : String(e)}`);
  };
  const transport = new StdioClientTransport({
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    // Sandbox layer 1: the server never sees API keys/tokens from the parent
    // env (scrubEnv); only its explicitly registered env lands.
    env: scrubEnv(server.env),
    // Sandbox layer 2: the server starts inside the workspace, so its
    // relative file operations stay in the repo.
    cwd: options.cwd,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport, { timeout: options.connectTimeoutMs });
    const listed = await client.listTools();
    const tools = listed.tools.map((t) =>
      toGuppyTool(name, t, client, options.callTimeoutMs),
    );
    const rootPid = transport.pid;
    if (rootPid !== null) trackMcpProcess(rootPid, name);
    return { name, client, transport, tools };
  } catch (e) {
    // Clean up a half-initialized server so a partial spawn never leaves an
    // orphan process behind, then rethrow for the loop to count as failed.
    const partialPid = transport.pid;
    if (partialPid !== null) {
      forceKill(partialPid);
      untrackMcpProcess(partialPid);
    }
    void client.close().catch(() => {});
    throw e;
  }
}

/** Convert an MCP tool into a `GuppyTool` backed by a live client. */
function toGuppyTool(
  serverName: string,
  tool: { name: string; description?: string | undefined; inputSchema?: { [k: string]: unknown } },
  client: Client,
  callTimeoutMs: number,
): GuppyTool {
  const schema = tool.inputSchema ?? {};
  const name = `${serverName}${MCP_TOOL_SEPARATOR}${tool.name}`;
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name,
      description: `${tool.description ?? 'MCP tool from server ' + serverName} (MCP server: ${serverName})`,
      parameters: {
        type: 'object',
        ...(schema['properties'] ? { properties: schema['properties'] } : {}),
        ...(schema['required'] ? { required: schema['required'] as string[] } : {}),
      },
    },
  };

  return {
    name,
    definition,
    async execute(args, _workspaceId: ULID): Promise<ToolExecution> {
      let result;
      try {
        result = await client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          { timeout: callTimeoutMs },
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { output: '', error: `[mcp:${serverName}/${tool.name}] ${message}` };
      }
      const output = serializeContent(result.content);
      if (result.isError) {
        return { output, error: `[mcp:${serverName}/${tool.name}] tool reported an error` };
      }
      return { output };
    },
  };
}

/**
 * Flatten an MCP call result's content blocks into a single text output.
 * Text blocks pass through; binary blocks (image/audio) are summarized rather
 * than dumped, because a base64 blob in the tool result would blow the model
 * context and the agent cannot see the bytes anyway.
 */
function serializeContent(content: unknown): string {
  if (!Array.isArray(content)) return content === undefined || content === null ? '(empty result)' : JSON.stringify(content);
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text ?? '');
        break;
      case 'image':
        parts.push(`[image: ${block.mimeType ?? 'unknown'}, ${block.data?.length ?? 0} bytes base64]`);
        break;
      case 'audio':
        parts.push(`[audio: ${block.mimeType ?? 'unknown'}, ${block.data?.length ?? 0} bytes base64]`);
        break;
      case 'resource': {
        const r = block.resource;
        parts.push(r?.text ?? `[resource: ${r?.uri ?? block.uri ?? 'unknown'}]`);
        break;
      }
      default:
        parts.push(`[content: ${block.type}]`);
    }
  }
  return parts.filter((p) => p !== '').join('\n') || '(empty result)';
}
