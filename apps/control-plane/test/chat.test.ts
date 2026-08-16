/**
 * guppy chat turn — runChatTurn must report a success summary from the gated
 * loop and degrade to a failed-turn result when the runtime crashes.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  now,
  ulid,
  type AgentRuntime,
  type Checkpoint,
  type Context,
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
import { createSessionManager } from '../src/session-manager.js';
import { runChat, runChatTurn } from '../src/chat.js';

// `runChat` builds its own runtime through `buildAgentRuntime`; stub the core
// factory so a scripted, gate-controlled runtime stands in for a real model.
const runtimeSlot = vi.hoisted(() => ({ runtime: undefined as unknown as AgentRuntime }));
vi.mock('@guppy/core', () => ({ createCoreRuntime: () => runtimeSlot.runtime }));

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

const PACKAGE_JSON = JSON.stringify({
  name: 'chat-e2e',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/*.test.ts' },
});

const PASSING_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('truth', () => {
  assert.equal(1, 1);
});
`;

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), PACKAGE_JSON, 'utf8');
  writeFileSync(join(dir, 'test', 'truth.test.ts'), PASSING_TEST, 'utf8');
}

const EMPTY_METRICS = {
  passes: 0,
  failures: 0,
  tokensTotal: 0,
  tokensByModel: {},
  wallTimeMs: 0,
  toolCalls: 0,
  checkpoints: 0,
  contextSelections: 0,
  verificationEscalations: 0,
};

/** A runtime that succeeds immediately with scripted metrics (no model needed). */
class FakeRuntime implements AgentRuntime {
  async initialize(_workspace: Workspace): Promise<void> {}
  async shutdown(): Promise<void> {}
  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    return {
      ok: true,
      value: {
        id: ulid(),
        taskId: task.id,
        sessionId: context.sessionId,
        events: [],
        outcome: 'success',
        metrics: { ...EMPTY_METRICS, tokensTotal: 500, toolCalls: 3 },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }
}

/** A runtime that throws mid-run, like a provider hang or a crash. */
class CrashRuntime implements AgentRuntime {
  async initialize(_workspace: Workspace): Promise<void> {}
  async shutdown(): Promise<void> {}
  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }
  async run(_task: Task, _context: Context): Promise<Result<Trajectory, Error>> {
    throw new Error('simulated chat crash');
  }
}

/** A runtime that blocks in run() until released — lets a test hold a turn in flight. */
class SlowRuntime extends FakeRuntime {
  started = false;
  private gate = deferred<void>();
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    this.started = true;
    await this.gate.promise;
    return super.run(task, context);
  }
  release(): void {
    this.gate.resolve();
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeTask(repoPath: string, description: string): Task {
  return {
    id: ulid(),
    description,
    repoPath,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: { chat: true },
  };
}

async function makeSession(
  dir: string,
  fixtureDir: string,
  runtime: AgentRuntime,
): Promise<{ eventStore: ReturnType<typeof createEventStore>; sessionManager: ReturnType<typeof createSessionManager> }> {
  const eventStore = createEventStore({ rootDir: join(dir, 'events') });
  const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
  const verifier = createVerificationEngine({
    eventStore,
    workspaceManager: wm,
    projectRoot: fixtureDir,
    timeout: 60_000,
  });
  const memoryStore = createMemoryStore({ rootDir: join(dir, 'memory') });
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
  return { eventStore, sessionManager };
}

describe('runChatTurn', () => {
  it('reports a success summary from the gated loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-chat-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const { eventStore, sessionManager } = await makeSession(dir, fixtureDir, new FakeRuntime());
    try {
      const result = await runChatTurn(sessionManager, makeTask(fixtureDir, 'Add a passing test'));
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('success');
      expect(result.tokens).toBe(500);
      expect(result.toolCalls).toBe(3);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await eventStore.close();
    }
  });

  it('degrades to a failed turn when the runtime crashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-chat-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const { eventStore, sessionManager } = await makeSession(dir, fixtureDir, new CrashRuntime());
    try {
      const result = await runChatTurn(sessionManager, makeTask(fixtureDir, 'fix everything'));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('simulated chat crash');
    } finally {
      await eventStore.close();
    }
  });
});

/**
 * Drive the full `runChat` REPL through a scripted input stream, send a
 * mid-turn exit signal while the runtime is blocked in run(), then release the
 * turn. Returns everything chat.ts wrote to the console for assertion.
 */
async function runReplWithMidTurnExit(trigger: (input: PassThrough) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-chat-repl-'));
  tmpDirs.push(dir);
  const fixtureDir = join(dir, 'fixture');
  writeFixture(fixtureDir);

  const slow = new SlowRuntime();
  runtimeSlot.runtime = slow;

  // chat.ts writes its UI via console.log/console.error, not the `output`
  // stream, so capture those to assert on the shutdown output.
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };

  const input = new PassThrough();
  try {
    await runChat({
      repoPath: fixtureDir,
      runtime: 'core',
      model: 'fake/chat',
      maxTurns: 1,
      verificationLevel: 3,
      quiet: true,
      local: true,
      keepWorktree: true,
      worktreeBase: join(dir, 'worktrees'),
      input,
      output: new PassThrough(),
    });

    input.write('do a task\n');
    await waitFor(() => slow.started, 20_000);
    trigger(input);
    // Give readline a beat to process the exit line (or EOF) before the turn
    // resolves, so the shutdown genuinely happens while the turn is in flight.
    await new Promise((r) => setTimeout(r, 50));
    slow.release();

    await waitFor(() => lines.some((l) => l.includes('Bye.')), 20_000);
    return lines.join('\n');
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

describe('runChat REPL — mid-turn exit', () => {
  it('finishes the in-flight turn and shuts down cleanly on /exit', async () => {
    const out = await runReplWithMidTurnExit((input) => input.write('/exit\n'));
    expect(out).toContain('completed (success)');
    expect(out.match(/Bye\./g) ?? []).toHaveLength(1);
    expect(out).not.toContain('ERR_USE_AFTER_CLOSE');
    expect(out).not.toContain('ERR_STREAM_WRITE_AFTER_END');
  });

  it('finishes the in-flight turn and shuts down cleanly on stdin EOF', async () => {
    const out = await runReplWithMidTurnExit((input) => input.end());
    expect(out).toContain('completed (success)');
    expect(out.match(/Bye\./g) ?? []).toHaveLength(1);
    expect(out).not.toContain('ERR_USE_AFTER_CLOSE');
    expect(out).not.toContain('ERR_STREAM_WRITE_AFTER_END');
  });
});
