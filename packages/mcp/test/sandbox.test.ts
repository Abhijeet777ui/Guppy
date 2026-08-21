/**
 * Sandbox tests: prove the three containment layers hold against a hostile
 * server that tries to escape the workspace in every direction a plain child
 * process can — spawning a detached grandchild, reading credentials from the
 * environment, and writing files by relative path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from '@guppy/contracts';
import { connectMcpServers, type McpBridge, type McpConfig } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/hostile-server.mjs', import.meta.url));

const openBridges: McpBridge[] = [];
const workdirs: string[] = [];
const REPORT_FILE = join(process.cwd(), 'sandbox-report.json');

afterEach(async () => {
  for (const bridge of openBridges.splice(0)) await bridge.close();
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // If cwd confinement ever failed, a leaked report would land in the test's
  // own cwd — clean it up so one failure can't poison later runs.
  rmSync(REPORT_FILE, { force: true });
});

/** A registered hostile server: it brings its own env, which must survive scrubbing. */
function hostileConfig(workspace: string): McpConfig {
  return {
    mcpServers: {
      hostile: {
        command: process.execPath,
        args: [FIXTURE],
        env: { MCP_ALLOWED: 'yes' },
      },
    },
  };
}

/** True while a process with this pid exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the pid is gone (SIGKILL delivery can lag by a tick). */
async function waitForDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

interface HostileReport {
  cwd: string;
  sawApiKey: boolean;
  sawAnthropicKey: boolean;
  sawPath: boolean;
  sawAllowedOverride: boolean;
  grandchildPid: number | null;
}

async function connectHostile(workspace: string): Promise<McpBridge> {
  const bridge = await connectMcpServers(hostileConfig(workspace), { cwd: workspace, log: () => {} });
  openBridges.push(bridge);
  return bridge;
}

async function probe(bridge: McpBridge): Promise<HostileReport> {
  const reportTool = bridge.tools.find((t) => t.name === 'hostile__report')!;
  const result = await reportTool.execute({}, ulid());
  expect(result.error).toBeUndefined();
  return JSON.parse(result.output) as HostileReport;
}

describe('MCP sandbox', () => {
  it('confines the server to the workspace: cwd and relative writes stay in the repo', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'guppy-sandbox-'));
    workdirs.push(workspace);

    const bridge = await connectHostile(workspace);
    const report = await probe(bridge);

    // The server's process.cwd() is the workspace, not wherever the CLI ran.
    // Compare realpaths: on macOS /var is a symlink to /private/var, so the
    // child's resolved cwd differs textually from the tmpdir() path.
    expect(realpathSync(report.cwd)).toBe(realpathSync(workspace));
    // Its relative write landed inside the workspace...
    expect(existsSync(join(workspace, 'sandbox-report.json'))).toBe(true);
    // ...and NOT in the test's own cwd (escape attempt 3 failed).
    expect(existsSync(REPORT_FILE)).toBe(false);
  });

  it('scrubs credentials from the server env while keeping safe vars and explicit overrides', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'guppy-sandbox-'));
    workdirs.push(workspace);

    // Plant credentials in the parent env; the server must never see them.
    const saved: Array<[string, string | undefined]> = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].map((k) => [
      k,
      process.env[k],
    ]);
    process.env.OPENAI_API_KEY = 'sk-should-never-leak';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-leak';
    try {
      const bridge = await connectHostile(workspace);
      const report = await probe(bridge);

      // Escape attempt 2 failed: no credentials crossed the boundary.
      expect(report.sawApiKey).toBe(false);
      expect(report.sawAnthropicKey).toBe(false);
      // Safe vars survive, and the server's explicitly registered env lands.
      expect(report.sawPath).toBe(true);
      expect(report.sawAllowedOverride).toBe(true);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('kills the server and its whole process tree on session end', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'guppy-sandbox-'));
    workdirs.push(workspace);

    const bridge = await connectHostile(workspace);
    const report = await probe(bridge);

    // The detached grandchild exists while the session is alive.
    expect(report.grandchildPid).toBeTruthy();
    const grandchildPid = report.grandchildPid!;
    expect(isAlive(grandchildPid)).toBe(true);

    // Session ends: the SDK's own close() only kills the direct child, so a
    // detached grandchild surviving this call is the exact escape the
    // tree-kill exists to close.
    await bridge.close();
    openBridges.splice(openBridges.indexOf(bridge), 1);

    expect(await waitForDeath(grandchildPid)).toBe(true);
  });
});
