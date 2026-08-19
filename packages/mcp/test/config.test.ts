/** Unit tests for the MCP server config (load/save/add/remove). */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addMcpServer,
  loadMcpConfig,
  removeMcpServer,
  saveMcpConfig,
} from '../src/index.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir; harmless.
    }
  }
});

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-mcp-config-'));
  tmpDirs.push(dir);
  return join(dir, 'mcp.json');
}

describe('MCP server config', () => {
  it('round-trips a server through add, load, and remove', () => {
    const path = tempConfigPath();
    addMcpServer(
      'fetch',
      { command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
      path,
    );
    const loaded = loadMcpConfig(path);
    expect(loaded.mcpServers['fetch']).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
    });

    removeMcpServer('fetch', path);
    expect(loadMcpConfig(path).mcpServers).toEqual({});
  });

  it('replaces an existing server with the same name', () => {
    const path = tempConfigPath();
    addMcpServer('s', { command: 'a' }, path);
    addMcpServer('s', { command: 'b', args: ['--x'] }, path);
    expect(loadMcpConfig(path).mcpServers['s']).toEqual({ command: 'b', args: ['--x'] });
  });

  it('keeps unrelated servers when removing one', () => {
    const path = tempConfigPath();
    addMcpServer('one', { command: 'a' }, path);
    addMcpServer('two', { command: 'b' }, path);
    removeMcpServer('one', path);
    const loaded = loadMcpConfig(path);
    expect(Object.keys(loaded.mcpServers)).toEqual(['two']);
  });

  it('degrades to empty on a corrupt file', () => {
    const path = tempConfigPath();
    writeFileSync(path, 'this is not json{', 'utf8');
    expect(loadMcpConfig(path)).toEqual({ mcpServers: {} });
  });

  it('saveMcpConfig writes a parseable file with a version', () => {
    const path = tempConfigPath();
    saveMcpConfig({ mcpServers: { s: { command: 'c' } } }, path);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.mcpServers['s']).toEqual({ command: 'c' });
  });
});
