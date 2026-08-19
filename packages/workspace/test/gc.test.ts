/**
 * GC — crashed-run residue cleanup. Normal failed/cancelled runs tear down
 * their own workspace; GC exists for hard crashes (kill -9, power loss)
 * where teardown never ran. The safety contract:
 *
 * - A workspace referenced by a FRESH checkpoint is kept (resumable).
 * - A worktree dir younger than max-age is kept even without a checkpoint
 *   (a run may still be in its pre-checkpoint window).
 * - The main checkout is never touched, and git worktrees of other repos
 *   (`.git` entries under the shared worktree base) are skipped.
 * - `force` sweeps everything guppy-*; `maxAgeDays` ages residue out.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceManager, type WorkspaceManager } from '../src/index.js';

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

function initGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, 'file.ts'), 'export const a = 1;\n', 'utf8');
  execSync('git init -q', { cwd: repoPath });
  execSync('git config user.name T', { cwd: repoPath });
  execSync('git config user.email t@t', { cwd: repoPath });
  execSync('git add -A && git commit -qm init', { cwd: repoPath });
}

/** A fresh manager simulates a crash: its in-memory state knows nothing. */
function freshManager(base: string): WorkspaceManager {
  return createWorkspaceManager({ useContainers: false, worktreeBase: join(base, 'worktrees') });
}

const DAY = 24 * 60 * 60 * 1000;

describe('WorkspaceManager.gc (git repos)', () => {
  it('removes an orphaned guppy-* branch with no worktree and no checkpoint', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-branch-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    initGitRepo(repoPath);
    // A pre-fix leak: a branch with no worktree registration behind it.
    execSync('git branch guppy-abc12345', { cwd: repoPath });

    const res = await freshManager(base).gc(repoPath, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.removed.some((r) => r.kind === 'branch' && r.branch === 'guppy-abc12345')).toBe(true);

    const branches = execSync('git branch', { cwd: repoPath, encoding: 'utf8' });
    expect(branches).not.toContain('guppy-abc12345');
  });

  it('keeps crash residue referenced by a fresh checkpoint (resumable)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-fresh-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    initGitRepo(repoPath);

    const wm = freshManager(base);
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const branch = `guppy-${created.value.id.slice(0, 8)}`;

    const res = await freshManager(base).gc(repoPath, {
      checkpoints: [
        { workspaceId: created.value.id, workspacePath: created.value.worktreePath!, createdAt: Date.now() },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.removed).toHaveLength(0);
    expect(res.value.kept.some((k) => k.branch === branch)).toBe(true);
    // Nothing was deleted — resume still works.
    expect(existsSync(created.value.worktreePath!)).toBe(true);
    expect(execSync('git branch', { cwd: repoPath, encoding: 'utf8' })).toContain(branch);

    await wm.destroyWorkspace(created.value.id, { deleteBranch: true, forceDeleteBranch: true });
  });

  it('removes crash residue whose checkpoint has aged past max-age', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-aged-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    initGitRepo(repoPath);

    const wm = freshManager(base);
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const branch = `guppy-${created.value.id.slice(0, 8)}`;
    const worktreePath = created.value.worktreePath!;

    const res = await freshManager(base).gc(repoPath, {
      checkpoints: [
        {
          workspaceId: created.value.id,
          workspacePath: worktreePath,
          createdAt: Date.now() - 30 * DAY, // abandoned a month ago
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.removed.some((r) => r.kind === 'worktree' && r.branch === branch)).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(execSync('git branch', { cwd: repoPath, encoding: 'utf8' })).not.toContain(branch);
  });

  it('--force removes residue even with a fresh checkpoint', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-force-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    initGitRepo(repoPath);

    const wm = freshManager(base);
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const res = await freshManager(base).gc(repoPath, {
      force: true,
      checkpoints: [
        { workspaceId: created.value.id, workspacePath: created.value.worktreePath!, createdAt: Date.now() },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.removed.length).toBeGreaterThan(0);
    expect(existsSync(created.value.worktreePath!)).toBe(false);
  });

  it('keeps a checkpoint-less worktree while it is young, removes it once aged', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-window-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    initGitRepo(repoPath);

    const wm = freshManager(base);
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktreePath = created.value.worktreePath!;

    // No checkpoint at all: the fresh dir is protected (possible active run).
    const young = await freshManager(base).gc(repoPath, {});
    expect(young.ok).toBe(true);
    if (!young.ok) return;
    expect(young.value.removed).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(true);

    // maxAge 0 ages it out immediately (dir mtime > 0 always).
    const aged = await freshManager(base).gc(repoPath, { maxAgeDays: 0 });
    expect(aged.ok).toBe(true);
    if (!aged.ok) return;
    expect(aged.value.removed.length).toBeGreaterThan(0);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('never touches the main checkout, even on a guppy branch', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-main-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    initGitRepo(repoPath);
    execSync('git checkout -b guppy-maincheck', { cwd: repoPath });

    const res = await freshManager(base).gc(repoPath, { force: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.removed).toHaveLength(0);
    expect(res.value.kept.some((k) => k.branch === 'guppy-maincheck')).toBe(true);
    const branches = execSync('git branch', { cwd: repoPath, encoding: 'utf8' });
    expect(branches).toContain('guppy-maincheck');
  });

  it('dry-run reports without deleting anything', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-dry-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    initGitRepo(repoPath);
    execSync('git branch guppy-abc12345', { cwd: repoPath });

    const res = await freshManager(base).gc(repoPath, { dryRun: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.removed.length).toBe(1);
    expect(res.value.removed[0]!.reason).toContain('(dry-run)');
    expect(execSync('git branch', { cwd: repoPath, encoding: 'utf8' })).toContain('guppy-abc12345');
  });
});

describe('WorkspaceManager.gc (non-git plain-copy worktrees)', () => {
  it('removes an aged orphan plain-copy dir, keeps a fresh one', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-plain-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, 'file.ts'), 'export const a = 1;\n', 'utf8');

    const wm = freshManager(base);
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktreePath = created.value.worktreePath!;

    // Fresh dir with no checkpoint → kept (possibly active).
    const young = await freshManager(base).gc(repoPath, {});
    expect(young.ok).toBe(true);
    if (!young.ok) return;
    expect(young.value.removed).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(true);

    // maxAge 0 → aged out and removed.
    const aged = await freshManager(base).gc(repoPath, { maxAgeDays: 0 });
    expect(aged.ok).toBe(true);
    if (!aged.ok) return;
    expect(aged.value.removed.some((r) => r.kind === 'plain-worktree')).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('keeps a plain-copy dir referenced by a fresh checkpoint, removes it when aged', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-gc-plain-cp-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, 'file.ts'), 'export const a = 1;\n', 'utf8');

    const wm = freshManager(base);
    const created = await wm.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktreePath = created.value.worktreePath!;
    const checkpoints = [
      { workspaceId: created.value.id, workspacePath: worktreePath, createdAt: Date.now() },
    ];

    const fresh = await freshManager(base).gc(repoPath, { checkpoints });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.removed).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(true);

    const aged = await freshManager(base).gc(repoPath, {
      checkpoints: checkpoints.map((c) => ({ ...c, createdAt: Date.now() - 30 * DAY })),
    });
    expect(aged.ok).toBe(true);
    if (!aged.ok) return;
    expect(aged.value.removed.length).toBeGreaterThan(0);
    expect(existsSync(worktreePath)).toBe(false);
  });
});
