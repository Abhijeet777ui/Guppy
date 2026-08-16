import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Task } from '@guppy/contracts';
import {
  deleteCheckpoint,
  latestCheckpoint,
  listCheckpoints,
  loadCheckpoint,
  saveCheckpoint,
  type RunCheckpoint,
} from '../src/checkpoint.js';

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

function baseTask(repoPath: string): Task {
  return {
    id: ulid(),
    description: 'fix the thing',
    repoPath,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: { bench: true },
  };
}

function makeCheckpoint(task: Task, attemptsCompleted: number, createdAt: string): RunCheckpoint {
  return {
    version: 1,
    task,
    attemptsCompleted,
    maxTurns: 3,
    testResults: [],
    errors: [],
    memories: [],
    context: null,
    workspaceId: ulid(),
    workspacePath: join(task.repoPath, '.guppy', 'worktrees', 'ws'),
    createdAt,
  };
}

describe('checkpoint store', () => {
  it('round-trips a checkpoint to disk and back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-checkpoint-'));
    tmpDirs.push(dir);
    const task = baseTask(dir);
    const cp = makeCheckpoint(task, 1, new Date(1000).toISOString());

    saveCheckpoint(dir, cp);
    const loaded = loadCheckpoint(dir, task.id);

    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.task.id).toBe(task.id);
    expect(loaded.task.metadata).toEqual({ bench: true });
    expect(loaded.attemptsCompleted).toBe(1);
    expect(loaded.workspacePath).toBe(cp.workspacePath);
  });

  it('lists checkpoints most-recent-first and resolves the latest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-checkpoint-'));
    tmpDirs.push(dir);
    const taskA = baseTask(dir);
    const taskB = baseTask(dir);

    saveCheckpoint(dir, makeCheckpoint(taskA, 0, new Date(1000).toISOString()));
    saveCheckpoint(dir, makeCheckpoint(taskB, 2, new Date(3000).toISOString()));

    const all = listCheckpoints(dir);
    expect(all.map((c) => c.task.id)).toEqual([taskB.id, taskA.id]);
    expect(latestCheckpoint(dir)?.task.id).toBe(taskB.id);
  });

  it('deletes a checkpoint by task id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-checkpoint-'));
    tmpDirs.push(dir);
    const task = baseTask(dir);
    saveCheckpoint(dir, makeCheckpoint(task, 0, new Date().toISOString()));

    deleteCheckpoint(dir, task.id);

    expect(loadCheckpoint(dir, task.id)).toBeNull();
    expect(latestCheckpoint(dir)).toBeNull();
  });
});
