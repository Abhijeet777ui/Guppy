/**
 * Run checkpoints — durable resume state for `guppy run --resume`.
 *
 * A checkpoint captures everything needed to continue an interrupted run at
 * the next attempt: the task, how many attempts already completed, the
 * accumulated failure feedback (test results / errors / memories), the last
 * selected context, and the local worktree to re-attach. It lives under
 * `<repo>/.guppy/checkpoints/` so it survives process death and machine
 * reboot alongside the event store.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Context, ErrorInfo, Memory, Task, TestResult, ULID } from '@guppy/contracts';

export interface RunCheckpoint {
  version: 1;
  task: Task;
  /** Number of attempts fully executed; the next attempt is this + 1. */
  attemptsCompleted: number;
  maxTurns: number;
  testResults: TestResult[];
  errors: ErrorInfo[];
  memories: Memory[];
  /** Last selected context, reused as previousContext on the resumed attempt. */
  context: Context | null;
  workspaceId: ULID;
  /** Absolute path to the local worktree to re-attach. */
  workspacePath: string;
  /** Container id of the interrupted run (container mode); reaped on resume. */
  containerId?: string;
  createdAt: string;
}

export function checkpointDir(repoPath: string): string {
  return join(repoPath, '.guppy', 'checkpoints');
}

function checkpointPath(repoPath: string, taskId: ULID): string {
  return join(checkpointDir(repoPath), `${taskId}.json`);
}

export function saveCheckpoint(repoPath: string, checkpoint: RunCheckpoint): void {
  mkdirSync(checkpointDir(repoPath), { recursive: true });
  writeFileSync(
    checkpointPath(repoPath, checkpoint.task.id),
    JSON.stringify(checkpoint, null, 2),
    'utf8',
  );
}

export function loadCheckpoint(repoPath: string, taskId: ULID): RunCheckpoint | null {
  const path = checkpointPath(repoPath, taskId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunCheckpoint;
  } catch {
    return null;
  }
}

/** All persisted checkpoints for a repo, most recent first. */
export function listCheckpoints(repoPath: string): RunCheckpoint[] {
  const dir = checkpointDir(repoPath);
  if (!existsSync(dir)) return [];
  const checkpoints: RunCheckpoint[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      checkpoints.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as RunCheckpoint);
    } catch {
      // A corrupt checkpoint is skipped — the others remain resumable.
    }
  }
  return checkpoints.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function latestCheckpoint(repoPath: string): RunCheckpoint | null {
  return listCheckpoints(repoPath)[0] ?? null;
}

export function deleteCheckpoint(repoPath: string, taskId: ULID): void {
  try {
    rmSync(checkpointPath(repoPath, taskId), { force: true });
  } catch {
    // Best-effort cleanup; a stale checkpoint is harmless.
  }
}
