/**
 * Worktree merge-back — a successful run must leave its changes in the source
 * repo instead of destroying them with the worktree, and --keep-worktree must
 * keep the worktree for inspection on either outcome.
 *
 * Covers the workspace-level merge (git + plain-copy modes) and the
 * session-level teardown wiring.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
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

function makeTask(repoPath: string, description = 'Do the thing'): Task {
  return {
    id: ulid(),
    description,
    repoPath,
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Workspace-level merge
// ---------------------------------------------------------------------------

describe('WorkspaceManager.mergeBack', () => {
  it('merges a plain-copy worktree back into a non-git repo (including deletions)', async () => {
    const dir = makeDir('guppy-merge-copy-');
    const repoPath = join(dir, 'repo');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src', 'keep.ts'), 'export const keep = 1;\n');
    writeFileSync(join(repoPath, 'src', 'remove.ts'), 'export const remove = 1;\n');

    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktreePath = created.value.worktreePath!;

    // The agent edits the worktree: adds a file, modifies one, deletes one.
    writeFileSync(join(worktreePath, 'src', 'agent-fix.ts'), 'export const fix = true;\n');
    writeFileSync(join(worktreePath, 'src', 'keep.ts'), 'export const keep = 2;\n');
    rmSync(join(worktreePath, 'src', 'remove.ts'));

    const merged = await wm.mergeBack(created.value.id);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.filesChanged).toBeGreaterThanOrEqual(3);

    expect(readFileSync(join(repoPath, 'src', 'agent-fix.ts'), 'utf8')).toContain('fix = true');
    expect(readFileSync(join(repoPath, 'src', 'keep.ts'), 'utf8')).toContain('keep = 2');
    expect(existsSync(join(repoPath, 'src', 'remove.ts'))).toBe(false);

    // Teardown removes the worktree.
    await wm.destroyWorkspace(created.value.id);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('commits and merges a git worktree back into its repo', async () => {
    const dir = makeDir('guppy-merge-git-');
    const repoPath = join(dir, 'repo');
    mkdirSync(repoPath);
    execSync('git init -q', { cwd: repoPath });
    execSync('git config user.name Tester', { cwd: repoPath });
    execSync('git config user.email tester@local', { cwd: repoPath });
    writeFileSync(join(repoPath, 'file.ts'), 'export const a = 1;\n');
    execSync('git add -A && git commit -qm init', { cwd: repoPath });

    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktreePath = created.value.worktreePath!;

    writeFileSync(join(worktreePath, 'file.ts'), 'export const a = 2;\n');
    writeFileSync(join(worktreePath, 'new.ts'), 'export const b = 1;\n');

    const merged = await wm.mergeBack(created.value.id);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.value.filesChanged).toBe(2);

    // Changes landed in the main repo; the branch merges cleanly and the
    // worktree is removable.
    expect(readFileSync(join(repoPath, 'file.ts'), 'utf8')).toContain('a = 2');
    expect(existsSync(join(repoPath, 'new.ts'))).toBe(true);
    await wm.destroyWorkspace(created.value.id, { deleteBranch: true });
    const branches = execSync('git branch', { cwd: repoPath, encoding: 'utf8' });
    expect(branches).not.toContain('guppy-');
  });

  it('uses a custom commit message', async () => {
    const dir = makeDir('guppy-merge-msg-');
    const repoPath = join(dir, 'repo');
    mkdirSync(repoPath);
    execSync('git init -q', { cwd: repoPath });
    execSync('git config user.name Tester', { cwd: repoPath });
    execSync('git config user.email tester@local', { cwd: repoPath });
    writeFileSync(join(repoPath, 'file.ts'), 'export const a = 1;\n');
    execSync('git add -A && git commit -qm init', { cwd: repoPath });

    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.worktreePath!, 'file.ts'), 'export const a = 2;\n');

    const merged = await wm.mergeBack(created.value.id, { commitMessage: 'fix: custom subject' });
    expect(merged.ok).toBe(true);
    const log = execSync('git log --format=%s', { cwd: repoPath, encoding: 'utf8' });
    expect(log).toContain('fix: custom subject');
  });

  it('no-commit overlays the files without creating git history', async () => {
    const dir = makeDir('guppy-merge-nocommit-');
    const repoPath = join(dir, 'repo');
    mkdirSync(repoPath);
    execSync('git init -q', { cwd: repoPath });
    execSync('git config user.name Tester', { cwd: repoPath });
    execSync('git config user.email tester@local', { cwd: repoPath });
    writeFileSync(join(repoPath, 'file.ts'), 'export const a = 1;\n');
    execSync('git add -A && git commit -qm init', { cwd: repoPath });

    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Different byte-length from the committed content so git's stat cache
    // reliably detects the change after the overlay (see racy-git on Windows).
    writeFileSync(join(created.value.worktreePath!, 'file.ts'), 'export const a = 222;\n');
    writeFileSync(join(created.value.worktreePath!, 'new.ts'), 'export const b = 1;\n');

    const merged = await wm.mergeBack(created.value.id, { noCommit: true });
    expect(merged.ok).toBe(true);

    // Files are updated in the working tree but nothing was committed.
    expect(readFileSync(join(repoPath, 'file.ts'), 'utf8')).toContain('a = 222');
    expect(existsSync(join(repoPath, 'new.ts'))).toBe(true);
    const log = execSync('git log --oneline', { cwd: repoPath, encoding: 'utf8' });
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toContain('init');
    const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8' });
    expect(status).toContain('file.ts');
    expect(status).toContain('new.ts');
  });

  it('reports an error for an unknown workspace', async () => {
    const dir = makeDir('guppy-merge-missing-');
    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const merged = await wm.mergeBack(ulid());
    expect(merged.ok).toBe(false);
  });

  it('refuses to no-commit onto a dirty repo unless forced', async () => {
    const dir = makeDir('guppy-merge-dirty-');
    const repoPath = join(dir, 'repo');
    mkdirSync(repoPath);
    execSync('git init -q', { cwd: repoPath });
    execSync('git config user.name Tester', { cwd: repoPath });
    execSync('git config user.email tester@local', { cwd: repoPath });
    writeFileSync(join(repoPath, 'file.ts'), 'export const a = 1;\n');
    execSync('git add -A && git commit -qm init', { cwd: repoPath });

    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    writeFileSync(join(created.value.worktreePath!, 'file.ts'), 'export const a = 2;\n');

    // A local uncommitted edit appears in the source repo after the worktree
    // snapshot was taken.
    writeFileSync(join(repoPath, 'file.ts'), 'export const a = 999;\n');

    const refused = await wm.mergeBack(created.value.id, { noCommit: true });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain('dirty working tree');
    // The local edit survives the refusal.
    expect(readFileSync(join(repoPath, 'file.ts'), 'utf8')).toContain('a = 999');

    const forced = await wm.mergeBack(created.value.id, { noCommit: true, force: true });
    expect(forced.ok).toBe(true);
    expect(readFileSync(join(repoPath, 'file.ts'), 'utf8')).toContain('a = 2');
  });
});

// ---------------------------------------------------------------------------
// Session-level teardown
// ---------------------------------------------------------------------------

const PASSING_PACKAGE_JSON = JSON.stringify({
  name: 'merge-e2e',
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

function writePassingFixture(dir: string): void {
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), PASSING_PACKAGE_JSON, 'utf8');
  writeFileSync(join(dir, 'test', 'truth.test.ts'), PASSING_TEST, 'utf8');
}

/** A runtime that writes a file into its worktree, then reports success. */
class EditingRuntime implements AgentRuntime {
  private worktreePath = '';

  async initialize(workspace: Workspace): Promise<void> {
    this.worktreePath = workspace.worktreePath ?? '';
  }

  async shutdown(): Promise<void> {}

  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }

  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    writeFileSync(join(this.worktreePath, 'agent-note.txt'), 'fixed by agent\n');
    return {
      ok: true,
      value: {
        id: ulid(),
        taskId: task.id,
        sessionId: context.sessionId,
        events: [],
        outcome: 'success',
        metrics: { ...EMPTY_METRICS, tokensTotal: 100 },
        startedAt: now(),
        completedAt: now(),
      },
    };
  }
}

/** A runtime that crashes mid-run (like a provider hang). */
class CrashRuntime implements AgentRuntime {
  async initialize(_workspace: Workspace): Promise<void> {}
  async shutdown(): Promise<void> {}
  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return { ok: false, error: new Error('not implemented') };
  }
  async run(_task: Task, _context: Context): Promise<Result<Trajectory, Error>> {
    throw new Error('simulated crash');
  }
}

async function makeSession(
  dir: string,
  fixtureDir: string,
  runtime: AgentRuntime,
  options: { keepWorktree?: boolean; commitMessage?: string } = {},
): Promise<{
  eventStore: ReturnType<typeof createEventStore>;
  sessionManager: ReturnType<typeof createSessionManager>;
  worktreeBase: string;
}> {
  const worktreeBase = join(dir, 'worktrees');
  const eventStore = createEventStore({ rootDir: join(dir, 'events') });
  const wm = createWorkspaceManager({ useContainers: false, worktreeBase });
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
    maxTurns: 1,
    keepWorktree: options.keepWorktree ?? false,
    ...(options.commitMessage ? { commitMessage: options.commitMessage } : {}),
  });
  return { eventStore, sessionManager, worktreeBase };
}

describe('session teardown', () => {
  it('merges a successful run back into the repo and removes the worktree', async () => {
    const dir = makeDir('guppy-merge-session-');
    const fixtureDir = join(dir, 'fixture');
    writePassingFixture(fixtureDir);

    const { eventStore, sessionManager, worktreeBase } = await makeSession(dir, fixtureDir, new EditingRuntime());
    try {
      const result = await sessionManager.run(makeTask(fixtureDir));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('success');

      // The agent's file landed in the source repo, and the worktree is gone.
      expect(readFileSync(join(fixtureDir, 'agent-note.txt'), 'utf8')).toContain('fixed by agent');
      expect(readdirSync(worktreeBase)).toHaveLength(0);
    } finally {
      await eventStore.close();
    }
  });

  it('resolves the {task} template in the merge commit message', async () => {
    const dir = makeDir('guppy-merge-template-');
    const fixtureDir = join(dir, 'fixture');
    writePassingFixture(fixtureDir);
    execSync('git init -q', { cwd: fixtureDir });
    execSync('git config user.name Tester', { cwd: fixtureDir });
    execSync('git config user.email tester@local', { cwd: fixtureDir });
    execSync('git add -A && git commit -qm init', { cwd: fixtureDir });

    const { eventStore, sessionManager } = await makeSession(dir, fixtureDir, new EditingRuntime(), {
      commitMessage: 'fix: {task}',
    });
    try {
      const result = await sessionManager.run(makeTask(fixtureDir, 'Do the thing'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outcome).toBe('success');

      const log = execSync('git log --format=%s', { cwd: fixtureDir, encoding: 'utf8' });
      expect(log).toContain('fix: Do the thing');
    } finally {
      await eventStore.close();
    }
  });

  it('keeps the worktree on failure when --keep-worktree is set', async () => {
    const dir = makeDir('guppy-keep-');
    const fixtureDir = join(dir, 'fixture');
    writePassingFixture(fixtureDir);

    const { eventStore, sessionManager, worktreeBase } = await makeSession(dir, fixtureDir, new CrashRuntime(), {
      keepWorktree: true,
    });
    try {
      await expect(sessionManager.run(makeTask(fixtureDir))).rejects.toThrow('simulated crash');
      expect(readdirSync(worktreeBase).length).toBeGreaterThan(0);
    } finally {
      await eventStore.close();
    }
  });
});
