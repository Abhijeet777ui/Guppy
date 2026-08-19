/**
 * Hermetic checkpoint/resume tests — no network, no pi, no prime.
 *
 * 1. resumeTask re-attaches a previous run's worktree (simulating a fresh
 *    process), continues from the next attempt with the saved failure
 *    feedback, fixes the bug, and clears the checkpoint.
 * 2. An interrupted run (the runtime throws) leaves the latest checkpoint on
 *    disk so a later `guppy run --resume` can pick it up.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  now,
  ulid,
  type Checkpoint,
  type Context,
  type Event,
  type Result,
  type Task,
  type Trajectory,
  type Workspace,
  type AgentRuntime,
} from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { ContextEngine } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import { createMemoryStore } from '@guppy/memory';
import { createCoreRuntime } from '@guppy/core';
import { createSessionManager } from '../src/session-manager.js';
import { latestCheckpoint, loadCheckpoint, saveCheckpoint, type RunCheckpoint } from '../src/checkpoint.js';

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
  name: 'resume-e2e',
  private: true,
  type: 'module',
  scripts: { test: 'node --test test/*.test.ts' },
});

const TEST_FILE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/math.ts';

test('clamp keeps values inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});
`;

const BROKEN_SRC = `export function clamp(v: number, min: number, max: number): number {
  return Math.max(Math.min(v, min), max);
}
`;

const WRONG_FIX = `export function clamp(v: number, min: number, max: number): number {
  return v;
}
`;

const CORRECT_FIX = `export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
`;

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), PACKAGE_JSON, 'utf8');
  writeFileSync(join(dir, 'src', 'math.ts'), BROKEN_SRC, 'utf8');
  writeFileSync(join(dir, 'test', 'math.test.ts'), TEST_FILE, 'utf8');
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

/** Scripted model: wrong edit when unguided, correct edit once the failure is fed back. */
function startMock(): { server: Server; url: string } {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as {
        messages?: Array<{ role?: string; content?: string | null }>;
      };
      const messages = body.messages ?? [];
      const hasToolResult = messages.some((m) => m.role === 'tool');
      const guided = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('CURRENT TEST RESULTS'),
      );

      const response = hasToolResult ? finalAnswer() : writeCall(guided ? CORRECT_FIX : WRONG_FIX);

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
  });
  return { server, url: '' };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeTask(repoPath: string): Task {
  return {
    id: ulid(),
    description: 'Fix the failing clamp test by correcting src/math.ts.',
    repoPath,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
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

/** A runtime that does nothing on the first attempt, then throws to simulate a crash. */
class InterruptingRuntime implements AgentRuntime {
  runs = 0;

  async initialize(_workspace: Workspace): Promise<void> {}

  async shutdown(): Promise<void> {}

  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }

  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    this.runs++;
    if (this.runs >= 2) throw new Error('simulated crash');
    return {
      ok: true,
      value: {
        id: ulid(),
        taskId: task.id,
        sessionId: context.sessionId,
        events: [],
        outcome: 'partial',
        metrics: { ...EMPTY_METRICS },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }
}

/** Records whether resumeTask routed to resume() vs run(). */
class RecordingRuntime implements AgentRuntime {
  resumeCalls = 0;
  runCalls = 0;

  async initialize(_workspace: Workspace): Promise<void> {}

  async shutdown(): Promise<void> {}

  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    this.runCalls++;
    return {
      ok: true,
      value: {
        id: ulid(),
        taskId: task.id,
        sessionId: context.sessionId,
        events: [],
        outcome: 'success',
        metrics: { ...EMPTY_METRICS },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }

  async resume(checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    this.resumeCalls++;
    return {
      ok: true,
      value: {
        id: checkpoint.trajectoryId,
        taskId: checkpoint.taskId,
        sessionId: checkpoint.sessionId,
        events: [],
        outcome: 'success',
        metrics: { ...EMPTY_METRICS },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }
}

describe('checkpoint/resume', () => {
  it('resumes from a checkpoint, re-attaches the worktree, and fixes the bug', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-resume-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const mock = startMock();
    const url = await listen(mock.server);
    try {
      // First "process": create the workspace, apply the wrong fix (attempt 1's
      // outcome), and persist the checkpoint it would have left behind.
      const wm1 = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const wsResult = await wm1.createWorkspace(fixtureDir);
      expect(wsResult.ok).toBe(true);
      if (!wsResult.ok) return;
      const workspace = wsResult.value;
      const worktreePath = workspace.worktreePath ?? fixtureDir;
      writeFileSync(join(worktreePath, 'src', 'math.ts'), WRONG_FIX, 'utf8');

      const task = makeTask(fixtureDir);
      const checkpoint: RunCheckpoint = {
        version: 1,
        task,
        attemptsCompleted: 1,
        maxTurns: 3,
        testResults: [
          {
            id: ulid(),
            name: 'clamp keeps values inside the range',
            status: 'failed',
            duration: 0,
            output: 'AssertionError: clamp(-3, 0, 10) should be 0',
          },
        ],
        errors: [
          {
            id: ulid(),
            message: 'The verification gate failed: clamp keeps values inside the range',
            type: 'verification',
          },
        ],
        memories: [],
        context: null,
        workspaceId: workspace.id,
        workspacePath: worktreePath,
        createdAt: new Date().toISOString(),
      };
      saveCheckpoint(fixtureDir, checkpoint);

      // Second "process": fresh managers, resume from the checkpoint.
      
      const eventStore = createEventStore({ rootDir: join(dir, 'events') });
      const wm2 = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
      const verifier = createVerificationEngine({
        eventStore,
        workspaceManager: wm2,
        projectRoot: fixtureDir,
        timeout: 60_000,
      });
      const memoryStore = createMemoryStore({ rootDir: join(dir, 'memory') });
      const runtime = createCoreRuntime({
        eventStore,
        workspaceManager: wm2,
        model: { provider: 'fake', model: 'fake/nemotron', baseUrl: url },
        maxTurns: 10,
      });
      const sessionManager = createSessionManager({
        repoPath: fixtureDir,
        agentRuntime: runtime,
        contextEngine: new ContextEngine(),
        verificationEngine: verifier,
        eventStore,
        workspaceManager: wm2,
        memoryStore,
        maxTurns: checkpoint.maxTurns,
      });

      const result = await sessionManager.resumeTask(checkpoint);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('success');

      // Success is the proof the resumed attempt corrected the worktree: the
      // gate is a real `npm test` run, and it can only pass with CORRECT_FIX.
      // A terminal run also clears its checkpoint.
      expect(loadCheckpoint(fixtureDir, task.id)).toBeNull();

      await eventStore.close();
    } finally {
      await close(mock.server);
    }
  });

  it('keeps the latest checkpoint when a run is interrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-resume-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const verifier = createVerificationEngine({
      eventStore,
      workspaceManager: wm,
      projectRoot: fixtureDir,
      timeout: 60_000,
    });
    const memoryStore = createMemoryStore({ rootDir: join(dir, 'memory') });
    const runtime = new InterruptingRuntime();
    const task = makeTask(fixtureDir);
    const sessionManager = createSessionManager({
      repoPath: fixtureDir,
      agentRuntime: runtime,
      contextEngine: new ContextEngine(),
      verificationEngine: verifier,
      eventStore,
      workspaceManager: wm,
      memoryStore,
      maxTurns: 3,
    });

    // Attempt 1 gates red (fixture is broken) and checkpoints; attempt 2 throws.
    await expect(sessionManager.run(task)).rejects.toThrow('simulated crash');

    const checkpoint = latestCheckpoint(fixtureDir);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.attemptsCompleted).toBe(1);

    await eventStore.close();
  });

  it('resumes an interrupted conversation via runtime.resume() when a crashed session exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-resume-runtime-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    writeFixture(fixtureDir);

    const task = makeTask(fixtureDir);

    // First "process": the crashed attempt had already applied the correct
    // fix to the worktree before the process died, so the resumed gate goes
    // green the moment the conversation is picked back up.
    const wm1 = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const wsResult = await wm1.createWorkspace(fixtureDir);
    expect(wsResult.ok).toBe(true);
    if (!wsResult.ok) return;
    const workspace = wsResult.value;
    const worktreePath = workspace.worktreePath ?? fixtureDir;
    writeFileSync(join(worktreePath, 'src', 'math.ts'), CORRECT_FIX, 'utf8');

    // The crashed session: TaskStarted + a full-context snapshot, no terminal
    // event — exactly what a hard kill mid-attempt leaves behind.
    const sessionId = ulid();
    const eventStore1 = createEventStore({ rootDir: join(dir, 'events') });
    eventStore1.beginSession(task.id, sessionId);
    eventStore1.append({
      id: ulid(),
      timestamp: now(),
      type: 'TaskStarted',
      taskId: task.id,
      sessionId,
      payload: { task },
    } as Event);
    const context: Context = {
      taskId: task.id,
      sessionId,
      files: [],
      testResults: [],
      errors: [],
      memories: [],
      skills: [],
      tokensUsed: 0,
      maxTokens: 0,
      selectedAt: now(),
      selectionReasoning: '',
    };
    const snap = await eventStore1.createSnapshot(ulid(), 0, context, 'pre_tool');
    expect(snap.ok).toBe(true);
    await eventStore1.close();

    // The attempt-level checkpoint lets resumeTask re-attach the worktree.
    saveCheckpoint(fixtureDir, {
      version: 1,
      task,
      attemptsCompleted: 0,
      maxTurns: 3,
      testResults: [],
      errors: [],
      memories: [],
      context,
      workspaceId: workspace.id,
      workspacePath: worktreePath,
      createdAt: new Date().toISOString(),
    });

    // Second "process": fresh managers; resumeTask should route to resume().
    const eventStore2 = createEventStore({ rootDir: join(dir, 'events') });
    const wm2 = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const verifier = createVerificationEngine({
      eventStore: eventStore2,
      workspaceManager: wm2,
      projectRoot: fixtureDir,
      timeout: 60_000,
    });
    const memoryStore = createMemoryStore({ rootDir: join(dir, 'memory') });
    const runtime = new RecordingRuntime();
    const sessionManager = createSessionManager({
      repoPath: fixtureDir,
      agentRuntime: runtime,
      contextEngine: new ContextEngine(),
      verificationEngine: verifier,
      eventStore: eventStore2,
      workspaceManager: wm2,
      memoryStore,
      maxTurns: 3,
    });

    const result = await sessionManager.resumeTask(loadCheckpoint(fixtureDir, task.id)!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('success');

    // The seam: the interrupted conversation was resumed, never re-run fresh.
    expect(runtime.resumeCalls).toBe(1);
    expect(runtime.runCalls).toBe(0);

    // Terminal success clears the attempt-level checkpoint.
    expect(loadCheckpoint(fixtureDir, task.id)).toBeNull();

    await eventStore2.close();
  });
});
