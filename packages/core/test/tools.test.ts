import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ULID } from '@guppy/contracts';
import { createWorkspaceManager, type WorkspaceManager } from '@guppy/workspace';
import { buildGuppyTools } from '../src/tools.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir; harmless.
    }
  }
});

async function makeWorktree(): Promise<{ wm: WorkspaceManager; workspaceId: ULID; worktree: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-tools-'));
  tmpDirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');

  const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
  const created = await wm.createWorkspace(repo);
  return { wm, workspaceId: created.value.id, worktree: created.value.worktreePath! };
}

describe('search tool', () => {
  it('returns path:line:match lines', async () => {
    const { wm, workspaceId } = await makeWorktree();
    const search = buildGuppyTools(wm).find((t) => t.name === 'search')!;
    const result = await search.execute({ query: 'export const a' }, workspaceId);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('src/a.ts:1:export const a = 1;');
  });

  it('refuses a path that escapes the workspace', async () => {
    const { wm, workspaceId } = await makeWorktree();
    const search = buildGuppyTools(wm).find((t) => t.name === 'search')!;
    const result = await search.execute({ query: 'x', path: '../../etc' }, workspaceId);
    expect(result.error).toContain('escapes the workspace');
  });
});

describe('apply_patch tool', () => {
  it('modifies a file and reports the change', async () => {
    const { wm, workspaceId, worktree } = await makeWorktree();
    const apply = buildGuppyTools(wm).find((t) => t.name === 'apply_patch')!;
    const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n';
    const result = await apply.execute({ patch }, workspaceId);
    expect(result.error).toBeUndefined();
    expect(readFileSync(join(worktree, 'src', 'a.ts'), 'utf8')).toContain('a = 2');
    expect(result.filesChanged).toEqual([{ path: 'src/a.ts', operation: 'modify' }]);
  });

  it('creates and deletes files in one patch', async () => {
    const { wm, workspaceId, worktree } = await makeWorktree();
    const apply = buildGuppyTools(wm).find((t) => t.name === 'apply_patch')!;
    const patch = [
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+export const n = 1;',
      '--- a/src/b.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-export const b = 2;',
    ].join('\n');
    const result = await apply.execute({ patch }, workspaceId);
    expect(result.error).toBeUndefined();
    expect(existsSync(join(worktree, 'new.ts'))).toBe(true);
    expect(existsSync(join(worktree, 'src', 'b.ts'))).toBe(false);
    expect(result.filesChanged).toEqual([
      { path: 'new.ts', operation: 'create' },
      { path: 'src/b.ts', operation: 'delete' },
    ]);
  });

  it('refuses a patch whose path escapes the workspace', async () => {
    const { wm, workspaceId } = await makeWorktree();
    const apply = buildGuppyTools(wm).find((t) => t.name === 'apply_patch')!;
    const patch = '--- a/../../outside.txt\n+++ b/../../outside.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n';
    const result = await apply.execute({ patch }, workspaceId);
    expect(result.error).toContain('escapes the workspace');
  });
});

describe('git tools', () => {
  it('git_status/git_diff reflect worktree changes in a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-tools-git-'));
    tmpDirs.push(dir);
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execSync('git init -q', { cwd: repo });
    execSync('git config user.name Tester', { cwd: repo });
    execSync('git config user.email tester@local', { cwd: repo });
    writeFileSync(join(repo, 'file.ts'), 'export const a = 1;\n');
    execSync('git add -A && git commit -qm init', { cwd: repo });

    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const created = await wm.createWorkspace(repo);
    const tools = buildGuppyTools(wm);

    const apply = tools.find((t) => t.name === 'apply_patch')!;
    const patch = '--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 22;\n';
    await apply.execute({ patch }, created.value.id);

    const status = tools.find((t) => t.name === 'git_status')!;
    const statusResult = await status.execute({}, created.value.id);
    expect(statusResult.error).toBeUndefined();
    expect(statusResult.output).toContain('file.ts');

    const diff = tools.find((t) => t.name === 'git_diff')!;
    const diffResult = await diff.execute({}, created.value.id);
    expect(diffResult.error).toBeUndefined();
    expect(diffResult.output).toContain('a = 22');
  });

  it('git_status errors on a plain-copy (non-git) workspace', async () => {
    const { wm, workspaceId } = await makeWorktree();
    const status = buildGuppyTools(wm).find((t) => t.name === 'git_status')!;
    const result = await status.execute({}, workspaceId);
    expect(result.error).toContain('only available for git repositories');
  });
});
