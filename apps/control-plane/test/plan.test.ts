/**
 * SessionManager.plan() — the read-only half of Slice 4 plan/build. Proves a
 * plan run returns the plan text, records it as a `PlanProduced` event, and —
 * critically — never merges anything back, because the plan runtime had no
 * mutating tools.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function trajectory(task: Task, context: Context, finalAnswer: string): Trajectory {
  return {
    id: ulid(),
    taskId: task.id,
    sessionId: context.sessionId,
    events: [],
    outcome: 'success',
    finalAnswer,
    metrics: { ...EMPTY_METRICS, tokensTotal: 100, toolCalls: 0 },
    startedAt: now(),
    completedAt: now(),
  };
}

/** The read-only plan runtime: returns a plan, never mutates. */
class PlanRuntime implements AgentRuntime {
  async initialize(_workspace: Workspace): Promise<void> {}
  async shutdown(): Promise<void> {}
  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }
  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    return { ok: true, value: trajectory(task, context, '# Plan\n\n1. Read the file.\n2. Fix the clamp.') };
  }
}

/** A build runtime that must never be used by plan(). */
class BuildRuntime extends PlanRuntime {}

function makeTask(repoPath: string): Task {
  return {
    id: ulid(),
    description: 'plan the fix',
    repoPath,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: { chat: true, mode: 'plan' },
  };
}

describe('SessionManager.plan (Slice 4)', () => {
  it('returns the plan, records PlanProduced, and never merges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-plan-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'readme.md'), '# hi\n', 'utf8');

    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const mergeSpy = vi.spyOn(wm, 'mergeBack');

    const sessionManager = createSessionManager({
      repoPath: fixtureDir,
      agentRuntime: new BuildRuntime(),
      planRuntime: new PlanRuntime(),
      contextEngine: new ContextEngine(),
      verificationEngine: createVerificationEngine({
        eventStore,
        workspaceManager: wm,
        projectRoot: fixtureDir,
        timeout: 60_000,
      }),
      eventStore,
      workspaceManager: wm,
      memoryStore: createMemoryStore({ rootDir: join(dir, 'memory') }),
      maxTurns: 2,
    });

    const task = makeTask(fixtureDir);
    const result = await sessionManager.plan(task);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.plan).toBe('# Plan\n\n1. Read the file.\n2. Fix the clamp.');

    // The plan is durable: the store holds the PlanProduced event.
    const stored = await eventStore.getTrajectory(task.id, result.value.trajectory.sessionId);
    expect(stored?.events.some((e) => e.type === 'PlanProduced')).toBe(true);

    // A plan is read-only: nothing was merged back into the repo.
    expect(mergeSpy).not.toHaveBeenCalled();

    await eventStore.close();
  });

  it('falls back to the build runtime when no plan runtime is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-plan-fallback-'));
    tmpDirs.push(dir);
    const fixtureDir = join(dir, 'fixture');
    mkdirSync(fixtureDir, { recursive: true });

    const eventStore = createEventStore({ rootDir: join(dir, 'events') });
    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const sessionManager = createSessionManager({
      repoPath: fixtureDir,
      agentRuntime: new BuildRuntime(),
      contextEngine: new ContextEngine(),
      verificationEngine: createVerificationEngine({
        eventStore,
        workspaceManager: wm,
        projectRoot: fixtureDir,
        timeout: 60_000,
      }),
      eventStore,
      workspaceManager: wm,
      memoryStore: createMemoryStore({ rootDir: join(dir, 'memory') }),
      maxTurns: 2,
    });

    const result = await sessionManager.plan(makeTask(fixtureDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan).toBe('# Plan\n\n1. Read the file.\n2. Fix the clamp.');
    await eventStore.close();
  });
});
