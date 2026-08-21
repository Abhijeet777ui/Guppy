/**
 * Dependency provisioning + branch hygiene — the verification gate can only
 * be meaningful when the worktree can actually resolve the repo's tools:
 *
 * - Local mode links the source repo's node_modules into the worktree
 *   (junction on Windows, symlink elsewhere), so `npm test` scripts resolve
 *   their runners and `npx --no-install` resolves tsc/eslint.
 * - The node_modules link is infrastructure, never agent work: merge-back
 *   must not count it or commit it.
 * - Failed/cancelled runs force-delete their unmerged workspace branch
 *   instead of leaking guppy-xxxxxxxx branches into the repo.
 * - TIMEOUT CONTRACT: these tests spawn real npm/pnpm subprocesses and need
 *   >5s under `pnpm -r run test` parallel load — the package's test script
 *   sets `--testTimeout=15000`. If they regress, raise the script timeout;
 *   don't weaken the tests.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstallCommand, createWorkspaceManager } from '../src/index.js';

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

/** A repo whose tests depend on a binary that only exists in node_modules. */
function writeFixtureWithDeps(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'deps-test',
      private: true,
      type: 'module',
      scripts: { hello: 'hello' },
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const x = 1;\n', 'utf8');
  // The shim lives only in node_modules — the gate resolves it solely
  // through the worktree link. POSIX + Windows shims, like the lint e2e.
  writeFileSync(
    join(dir, 'node_modules', '.bin', 'hello'),
    '#!/usr/bin/env node\nconsole.log("hello from node_modules");\n',
    { encoding: 'utf8', mode: 0o755 },
  );
  writeFileSync(
    join(dir, 'node_modules', '.bin', 'hello.cmd'),
    '@ECHO off\r\nnode "%~dp0\\hello" %*\r\n',
    'utf8',
  );
}

describe('workspace dependency provisioning', () => {
  it('links the source repo node_modules into a plain-copy worktree so npm scripts resolve', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-deps-copy-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    writeFixtureWithDeps(repoPath);

    const mgr = createWorkspaceManager({ useContainers: false, worktreeBase: join(base, 'worktrees') });
    const created = await mgr.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktree = created.value.worktreePath!;

    // The copy strips node_modules, so the worktree only sees it through the link.
    expect(existsSync(join(worktree, 'node_modules', '.bin', 'hello'))).toBe(true);

    const res = await mgr.exec(created.value.id, ['npm', 'run', 'hello']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.exitCode).toBe(0);
    expect(res.value.stdout).toContain('hello from node_modules');

    await mgr.destroyWorkspace(created.value.id);
  });

  it('never counts or commits the worktree node_modules link when merging back a git worktree', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-deps-git-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src', 'main.ts'), 'export const x = 1;\n', 'utf8');
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'deps-git', private: true }), 'utf8');
    execSync('git init -q', { cwd: repoPath });
    execSync('git config user.name T', { cwd: repoPath });
    execSync('git config user.email t@t', { cwd: repoPath });
    execSync('git add -A && git commit -qm init', { cwd: repoPath });
    // node_modules appears after the commit (untracked, like a real install).
    mkdirSync(join(repoPath, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      join(repoPath, 'node_modules', '.bin', 'hello'),
      '#!/usr/bin/env node\nprocess.exit(0);\n',
      { encoding: 'utf8', mode: 0o755 },
    );

    const mgr = createWorkspaceManager({ useContainers: false, worktreeBase: join(base, 'worktrees') });
    const created = await mgr.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktree = created.value.worktreePath!;
    expect(existsSync(join(worktree, 'node_modules'))).toBe(true);

    // The agent edits a real file.
    writeFileSync(join(worktree, 'src', 'main.ts'), 'export const x = 2;\n', 'utf8');

    const merged = await mgr.mergeBack(created.value.id);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    // Only the real change counts — the node_modules link is infrastructure.
    expect(merged.value.filesChanged).toBe(1);

    // The merge commit contains no node_modules entry.
    const tracked = execSync('git ls-files', { cwd: repoPath, encoding: 'utf8' });
    expect(tracked).not.toContain('node_modules');
    expect(readFileSync(join(repoPath, 'src', 'main.ts'), 'utf8')).toContain('x = 2');
  });

  it('re-links node_modules on adopt when the worktree carries an empty node_modules artifact', async () => {
    // `npx --no-install` / `npm run` inside the sandbox create an EMPTY
    // node_modules in the worktree as a side effect. A naive "dir exists"
    // check mistakes it for deps and skips the source link — the resumed-run
    // gate regression (container e2e: resume test). Adopt must clear the
    // artifact and re-link so tools still resolve.
    const base = mkdtempSync(join(tmpdir(), 'guppy-deps-empty-nm-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    writeFixtureWithDeps(repoPath);

    const mgr = createWorkspaceManager({ useContainers: false, worktreeBase: join(base, 'worktrees') });
    const created = await mgr.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id, worktreePath } = created.value;

    // Replace the fresh link with the empty artifact (as a prior run left it).
    const nm = join(worktreePath!, 'node_modules');
    rmSync(nm, { recursive: true, force: true });
    mkdirSync(nm, { recursive: true });
    expect(readdirSync(nm)).toHaveLength(0);

    const adopted = await mgr.adoptWorkspace(id, worktreePath!, repoPath);
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(existsSync(join(nm, '.bin', 'hello'))).toBe(true);

    const res = await mgr.exec(id, ['npm', 'run', 'hello']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.exitCode).toBe(0);
    expect(res.value.stdout).toContain('hello from node_modules');

    await mgr.destroyWorkspace(id);
  });

  it('buildInstallCommand never writes a package-lock.json when the repo has none', () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-deps-lock-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'no-lock', private: true }), 'utf8');

    const cmd = buildInstallCommand(repoPath);
    expect(cmd[0]).toBe('npm');
    expect(cmd).toContain('--package-lock=false');
    // A guppy run must never add files to the repo it didn't author.
    expect(cmd).not.toContain('--package-lock=true');
  });

  it('buildInstallCommand respects an existing lockfile (stays pinned, no rewrite flag)', () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-deps-lock-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'has-lock', private: true }), 'utf8');
    writeFileSync(join(repoPath, 'package-lock.json'), '{}', 'utf8');

    const cmd = buildInstallCommand(repoPath);
    // With an existing lockfile the install stays pinned to it; the
    // suppression flag must NOT be applied (that would discard the pin).
    expect(cmd).not.toContain('--package-lock=false');
  });

  it('installs declared deps into the workspace (hermetically) without adding a lockfile', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-deps-install-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    // A file: dependency resolves entirely offline — no registry contact,
    // so the install branch runs end-to-end inside the test.
    mkdirSync(join(repoPath, 'vendor', 'localpkg'), { recursive: true });
    writeFileSync(
      join(repoPath, 'vendor', 'localpkg', 'package.json'),
      JSON.stringify({ name: 'localpkg', version: '1.0.0' }),
      'utf8',
    );
    writeFileSync(join(repoPath, 'vendor', 'localpkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({
        name: 'deps-install',
        private: true,
        dependencies: { localpkg: 'file:./vendor/localpkg' },
      }),
      'utf8',
    );

    const mgr = createWorkspaceManager({ useContainers: false, worktreeBase: join(base, 'worktrees') });
    const created = await mgr.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktree = created.value.worktreePath!;

    // The install fallback ran: the worktree gained a node_modules.
    expect(existsSync(join(worktree, 'node_modules'))).toBe(true);
    expect(existsSync(join(worktree, 'node_modules', 'localpkg'))).toBe(true);
    // The lockfile guarantee, live: no package-lock.json was written.
    expect(existsSync(join(worktree, 'package-lock.json'))).toBe(false);
    // The source repo itself was never touched.
    expect(existsSync(join(repoPath, 'node_modules'))).toBe(false);
    expect(existsSync(join(repoPath, 'package-lock.json'))).toBe(false);

    await mgr.destroyWorkspace(created.value.id);
  });

  it('--no-install (installDependencies: false) short-circuits the install fallback', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-deps-noinstall-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    mkdirSync(join(repoPath, 'vendor', 'localpkg'), { recursive: true });
    writeFileSync(
      join(repoPath, 'vendor', 'localpkg', 'package.json'),
      JSON.stringify({ name: 'localpkg', version: '1.0.0' }),
      'utf8',
    );
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({
        name: 'deps-noinstall',
        private: true,
        dependencies: { localpkg: 'file:./vendor/localpkg' },
      }),
      'utf8',
    );

    const mgr = createWorkspaceManager({
      useContainers: false,
      worktreeBase: join(base, 'worktrees'),
      installDependencies: false,
    });
    const created = await mgr.createWorkspace(repoPath);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktree = created.value.worktreePath!;

    // No node_modules, no lockfile, no install — the escape hatch holds.
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    expect(existsSync(join(worktree, 'package-lock.json'))).toBe(false);

    await mgr.destroyWorkspace(created.value.id);
  });

  it('force-deletes an unmerged workspace branch on demand, and keeps it otherwise', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-deps-branch-'));
    tmpDirs.push(base);
    const repoPath = join(base, 'repo');
    mkdirSync(repoPath);
    execSync('git init -q', { cwd: repoPath });
    execSync('git config user.name T', { cwd: repoPath });
    execSync('git config user.email t@t', { cwd: repoPath });
    writeFileSync(join(repoPath, 'file.ts'), 'export const a = 1;\n', 'utf8');
    execSync('git add -A && git commit -qm init', { cwd: repoPath });

    const mgr = createWorkspaceManager({ useContainers: false, worktreeBase: join(base, 'worktrees') });

    // A commit in the workspace makes its branch genuinely unmerged.
    const commitWip = (wt: string) => {
      writeFileSync(join(wt, 'change.ts'), 'export const z = 1;\n', 'utf8');
      execSync('git add -A && git commit -qm wip', { cwd: wt });
    };

    const currentBranch = (wt: string) =>
      execSync('git branch --show-current', { cwd: wt, encoding: 'utf8' }).trim();

    // Without force, the unmerged branch survives the destroy (conservative).
    const kept = await mgr.createWorkspace(repoPath);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    commitWip(kept.value.worktreePath!);
    const keptBranch = currentBranch(kept.value.worktreePath!);
    await mgr.destroyWorkspace(kept.value.id, { deleteBranch: true });
    let branches = execSync('git branch', { cwd: repoPath, encoding: 'utf8' });
    expect(branches).toContain(keptBranch);

    // With force, the unmerged scratch branch is cleaned up — this is what
    // the session manager requests on failed/cancelled runs.
    const cleaned = await mgr.createWorkspace(repoPath);
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) return;
    commitWip(cleaned.value.worktreePath!);
    const cleanedBranch = currentBranch(cleaned.value.worktreePath!);
    expect(cleanedBranch).not.toBe(keptBranch);
    await mgr.destroyWorkspace(cleaned.value.id, { deleteBranch: true, forceDeleteBranch: true });
    branches = execSync('git branch', { cwd: repoPath, encoding: 'utf8' });
    expect(branches).not.toContain(cleanedBranch);
  });
});
