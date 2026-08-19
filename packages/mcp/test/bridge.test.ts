/**
 * Bridge tests: a real stdio MCP server (the hermetic fixture) spawned as a
 * child process, connected through `connectMcpServers`, and driven exactly
 * the way the agent loop would drive it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ulid } from '@guppy/contracts';
import { connectMcpServers, MCP_TOOL_SEPARATOR, type McpBridge, type McpConfig } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url));

const openBridges: McpBridge[] = [];
afterEach(async () => {
  for (const bridge of openBridges.splice(0)) await bridge.close();
});

function mockConfig(serverName = 'mock'): McpConfig {
  return { mcpServers: { [serverName]: { command: process.execPath, args: [FIXTURE] } } };
}

describe('connectMcpServers', () => {
  it('connects a server, exposes prefixed tools, and executes a call round-trip', async () => {
    const bridge = await connectMcpServers(mockConfig(), { log: () => {} });
    openBridges.push(bridge);

    expect(bridge.connected).toBe(1);
    expect(bridge.failed).toBe(0);

    // Tools are prefixed with the server name so they can never shadow a
    // native tool (read_file, search, ...).
    const names = bridge.tools.map((t) => t.name).sort();
    expect(names).toEqual(['mock__add', 'mock__echo', 'mock__fail']);

    const echo = bridge.tools.find((t) => t.name === `mock${MCP_TOOL_SEPARATOR}echo`)!;
    expect(echo.definition.function.name).toBe('mock__echo');
    expect(echo.definition.function.parameters).toMatchObject({ type: 'object' });
    expect(echo.definition.function.description).toContain('mock');

    const result = await echo.execute({ text: 'hello from the loop' }, ulid());
    expect(result.output).toBe('echo: hello from the loop');
    expect(result.error).toBeUndefined();
  });

  it('forwards structured arguments to the server', async () => {
    const bridge = await connectMcpServers(mockConfig(), { log: () => {} });
    openBridges.push(bridge);
    const add = bridge.tools.find((t) => t.name === 'mock__add')!;
    const result = await add.execute({ a: 19, b: 23 }, ulid());
    expect(result.output).toBe('42');
  });

  it('surfaces a server-reported error instead of pretending success', async () => {
    const bridge = await connectMcpServers(mockConfig(), { log: () => {} });
    openBridges.push(bridge);
    const fail = bridge.tools.find((t) => t.name === 'mock__fail')!;
    const result = await fail.execute({}, ulid());
    expect(result.error).toContain('tool reported an error');
  });

  it('skips a broken server without failing the whole session', async () => {
    const bridge = await connectMcpServers(
      {
        mcpServers: {
          broken: { command: 'definitely-not-a-real-executable-xyz', args: [] },
          mock: { command: process.execPath, args: [FIXTURE] },
        },
      },
      { log: () => {} },
    );
    openBridges.push(bridge);

    expect(bridge.failed).toBe(1);
    expect(bridge.connected).toBe(1);
    // Only the healthy server's tools are exposed.
    expect(bridge.tools.map((t) => t.name).sort()).toEqual(['mock__add', 'mock__echo', 'mock__fail']);
  });

  it('exposes no tools when nothing is registered', async () => {
    const bridge = await connectMcpServers({ mcpServers: {} }, { log: () => {} });
    expect(bridge.connected).toBe(0);
    expect(bridge.tools).toEqual([]);
  });
});
