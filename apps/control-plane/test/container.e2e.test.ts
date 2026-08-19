/**
 * Container-mode E2E — the sandbox launch gate.
 *
 * 1. A full gated run inside the `guppy/executor` container: the seeded bug
 *    fails `npm test` inside the container, the mock model fixes the worktree
 *    on the host (visible through the bind mount), the gate passes in the
 *    container, and the fix merges back into the source repo.
 * 2. A crash mid-run leaves the checkpoint + worktree + a live container; a
 *    fresh session manager resumes in container mode, reaps the orphaned
 *    container, continues, and succeeds.
 *
 * Skipped when Docker is unavailable (e.g. plain CI), so the suite stays
 * green without a daemon.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

/** Promise wrapper around child_process.execFile. */
function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 60_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });
}
import {
  now,
  ulid,
  type AgentRuntime,
  type Checkpoint,
  type Context,
  type Event,
  type Result,
  type Task,
  type Trajectory,
  type Workspace,
} from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { ContextEngine } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import { createMemoryStore } from '@guppy/memory';
import { createCoreRuntime } from '@guppy/core';
import { createSessionManager } from '../src/session-manager.js';
import { latestCheckpoint } from '../src/checkpoint.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir after a child exits; harmless.
    }
  }
});

let dockerAvailable = false;
beforeAll(async () => {
  try {
    await run('docker', ['info'], { timeout: 10_000 });
    // The daemon alone isn't enough: the sandbox image is built locally
    // (`pnpm docker:build`) and won't exist on fresh CI runners, where the
    // container e2e must be skipped rather than run against a missing image.
    await run('docker', ['image', 'inspect', 'guppy/executor:latest'], { timeout: 10_000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
});

const PACKAGE_JSON = JSON.stringify({
  name: 'container-e2e',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/*.test.ts' },
});

const TEST_FILE = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/math.ts';\n\ntest('clamp keeps values inside the range', () => {\n  assert.equal(clamp(5, 0, 10), 5);\n  assert.equal(clamp(-3, 0, 10), 0);\n  assert.equal(clamp(15, 0, 10), 10);\n});\n`;

const BROKEN_SRC = `export function clamp(v: number, min: number, max: number): number {\n  return Math.max(Math.min(v, min), max);\n}\n`;

const CORRECT_FIX = `export function clamp(v: number, min: number, max: number): number {\n  return Math.min(Math.max(v, min), max);\n}\n`;

/** Container mode requires a git repo (worktrees are git-backed). */
async function writeGitFixture(dir: string): Promise<void> {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), PACKAGE_JSON, 'utf8');
  writeFileSync(join(dir, 'src', 'math.ts'), BROKEN_SRC, 'utf8');
  writeFileSync(join(dir, 'test', 'math.test.ts'), TEST_FILE, 'utf8');
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'init'], { cwd: dir });

  // node_modules is written AFTER the commit so it stays untracked on the
  // host: the container gets it via the workspace manager's bind mount at
  // /workspace/node_modules. The tsc shim proves tool levels actually
  // resolve inside the container — without the mount, `npx --no-install
  // tsc` fails and level 1 is skipped. The container is Linux, so only the
  // POSIX shim with the executable bit is needed.
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', '.bin', 'tsc'),
    '#!/usr/bin/env node\n// Hermetic tsc shim for the container e2e — always passes.\nprocess.exit(0);\n',
    { encoding: 'utf8', mode: 0o755 },
  );
}

function finalAnswer() {
  return {
    model: 'fake/nemotron',
    choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  };
}

function writeCall(content: string) {
  return {
    model: 'fake/nemotron',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/math.ts', content }) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

/** Scripted model: wrong edit when unguided, correct once the gate feeds back. */
function startMock(): { server: Server; url: string } {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as {
        messages?: Array<{ role?: string; content?: string | null }>;
      };
      const messages = body.messages ?? [];
      const hasToolResult = messages.some((m) => m.role === 'tool');
      const guided = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('CURRENT ERRORS'),
      );
      const response = hasToolResult ? finalAnswer() : writeCall(guided ? CORRECT_FIX : BROKEN_SRC);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
  });
  return { server, url: '' };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeTask(fixtureDir: string): Task {
  return {
    id: ulid(),
    description: 'Fix the failing clamp test by correcting src/math.ts.',
    repoPath: fixtureDir,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

/** A runtime that works, then throws to simulate a crash mid-run. */
class CrashingRuntime implements AgentRuntime {
  runs = 0;
  constructor(private inner: AgentRuntime) {}
  async initialize(workspace: Workspace): Promise<void> {
    await this.inner.initialize(workspace);
  }
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    this.runs++;
    if (this.runs >= 2) throw new Error('simulated crash');
    return this.inner.run(task, context);
  }
  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }
  resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    throw new Error('not implemented');
  }
}

describe('container mode (guppy/executor)', () => {
  it(
    'runs a gated task in the container and merges the fix back',
    { timeout: 180_000 },
    async () => {
    if (!dockerAvailable) return;

    const dir = mkdtempSync(join(tmpdir(), 'guppy-container-e2e-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    await writeGitFixture(fixtureDir);

    const mock = startMock();
    const url = await listen(mock.server);

    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const wm = createWorkspaceManager({
      useContainers: true,
      dockerImage: 'guppy/executor:latest',
      worktreeBase: join(dir, 'worktrees'),
    });
    const verifier = createVerificationEngine({
      eventStore,
      workspaceManager: wm,
      projectRoot: fixtureDir,
      timeout: 120_000,
    });
    const memoryStore = createMemoryStore({ rootDir: join(dir, 'memory') });
    const runtime = createCoreRuntime({
      eventStore,
      workspaceManager: wm,
      model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
      maxTurns: 10,
    });

    // The launch-posture probe passes when the daemon + image are available.
    expect(await wm.probeContainerRuntime()).toEqual({ ok: true });

    try {
      const sessionManager = createSessionManager({
        repoPath: fixtureDir,
        agentRuntime: runtime,
        contextEngine: new ContextEngine(),
        verificationEngine: verifier,
        eventStore,
        workspaceManager: wm,
        memoryStore,
        maxTurns: 2,
      });

      const task = makeTask(fixtureDir);
      const result = await sessionManager.run(task);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('success');

      // The gate ran inside the container and the fix merged back on the host.
      const merged = readFileSync(join(fixtureDir, 'src', 'math.ts'), 'utf8');
      expect(merged).toContain('Math.min(Math.max(v, min), max)');

      // Level 1 (tsc) actually ran inside the container: the shim lives in
      // the source repo's node_modules, which only resolves via the
      // /workspace/node_modules bind mount. Without the mount, `npx
      // --no-install tsc` would fail and no TypecheckPassed would land.
      const events: Event[] = [];
      const sessions = await eventStore.listSessions(task.id as never);
      for (const sessionId of sessions) {
        const trajectory = await eventStore.getTrajectory(task.id as never, sessionId);
        if (trajectory) events.push(...trajectory.events);
      }
      expect(events.some((e) => e.type === 'TypecheckPassed')).toBe(true);

      await eventStore.close();
    } finally {
      await close(mock.server);
    }
    },
  );

  it(
    'resumes an interrupted container run and reaps the orphaned container',
    { timeout: 180_000 },
    async () => {
    if (!dockerAvailable) return;

    const dir = mkdtempSync(join(tmpdir(), 'guppy-container-resume-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    await writeGitFixture(fixtureDir);

    const mock = startMock();
    const url = await listen(mock.server);
    const task = makeTask(fixtureDir);

    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const wm1 = createWorkspaceManager({
      useContainers: true,
      dockerImage: 'guppy/executor:latest',
      worktreeBase: join(dir, 'worktrees'),
    });
    const verifier = createVerificationEngine({
      eventStore,
      workspaceManager: wm1,
      projectRoot: fixtureDir,
      timeout: 120_000,
    });
    const memoryStore = createMemoryStore({ rootDir: join(dir, 'memory') });
    const realRuntime = createCoreRuntime({
      eventStore,
      workspaceManager: wm1,
      model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
      maxTurns: 10,
    });
    const crashRuntime = new CrashingRuntime(realRuntime);

    try {
      const first = createSessionManager({
        repoPath: fixtureDir,
        agentRuntime: crashRuntime,
        contextEngine: new ContextEngine(),
        verificationEngine: verifier,
        eventStore,
        workspaceManager: wm1,
        memoryStore,
        maxTurns: 3,
      });

      // Attempt 1 gates red and checkpoints (with the container id); attempt 2
      // throws — simulating a crash that leaves the worktree + container behind.
      await expect(first.run(task)).rejects.toThrow('simulated crash');

      const checkpoint = latestCheckpoint(fixtureDir);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.containerId).toBeTruthy();
      const orphanContainerId = checkpoint!.containerId!;

      // A fresh process resumes: new managers, new container bound to the
      // same worktree; the orphan is reaped.
      const eventStore2 = createEventStore({ rootDir: join(dir, 'events') });
      const wm2 = createWorkspaceManager({
        useContainers: true,
        dockerImage: 'guppy/executor:latest',
        worktreeBase: join(dir, 'worktrees'),
      });
      const verifier2 = createVerificationEngine({
        eventStore: eventStore2,
        workspaceManager: wm2,
        projectRoot: fixtureDir,
        timeout: 120_000,
      });
      const runtime2 = createCoreRuntime({
        eventStore: eventStore2,
        workspaceManager: wm2,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
      });
      const second = createSessionManager({
        repoPath: fixtureDir,
        agentRuntime: runtime2,
        contextEngine: new ContextEngine(),
        verificationEngine: verifier2,
        eventStore: eventStore2,
        workspaceManager: wm2,
        memoryStore,
        maxTurns: 3,
      });

      const result = await second.resumeTask(checkpoint!);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('success');

      // The orphaned container is gone.
      const { stdout } = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}']);
      expect(stdout.split(/\r?\n/)).not.toContain(orphanContainerId);

      // Checkpoint cleared after success.
      expect(latestCheckpoint(fixtureDir)).toBeNull();

      await eventStore2.close();
    } finally {
      await close(mock.server);
    }
    },
  );
});
