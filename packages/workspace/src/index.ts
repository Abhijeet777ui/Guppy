/**
 * Workspace Manager — Docker execution with git worktree isolation
 */

import type {
  Workspace,
  FileContent,
  ULID,
  Timestamp,
  Result,
} from '@guppy/contracts';
import { now, ulid, ok, err } from '@guppy/contracts';
import Docker from 'dockerode';
import { createWriteStream, createReadStream, existsSync, mkdirSync, rmSync, cpSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { join, dirname, basename, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { execa } from 'execa';
import { parseUnifiedDiff, applyHunks } from './patch.js';

export { parseUnifiedDiff, applyHunks };
export type { ParsedPatchFile, Hunk, HunkLine } from './patch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface WorkspaceConfig {
  dockerImage: string;
  worktreeBase: string;
  networkMode: string;
  memoryLimit: string;
  cpuLimit: number;
  timeout: number;
  /**
   * When false, workspaces are plain directory copies and commands run
   * directly on the host (no Docker). Used by the bench runner and by
   * `guppy run --local`.
   */
  useContainers: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  /** Source repo the worktree was created from — where changes merge back. */
  repoPath: string;
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  dockerImage: 'guppy/executor:latest',
  worktreeBase: join(process.cwd(), '.guppy', 'worktrees'),
  networkMode: 'bridge',
  memoryLimit: '4g',
  cpuLimit: 2,
  timeout: 300_000, // 5 minutes
  useContainers: true,
};

export class WorkspaceManager {
  private docker: Docker;
  private config: WorkspaceConfig;
  private activeContainers: Map<ULID, Docker.Container> = new Map();
  private activeWorktrees: Map<ULID, WorktreeInfo> = new Map();

  constructor(config: Partial<WorkspaceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.docker = new Docker();
    mkdirSync(this.config.worktreeBase, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Workspace Lifecycle
  // ---------------------------------------------------------------------------

  async createWorkspace(repoPath: string): Promise<Result<Workspace, Error>> {
    try {
      const workspaceId = ulid();
      const worktreePath = await this.createWorktree(repoPath, workspaceId);

      const workspace: Workspace = {
        id: workspaceId,
        repoPath,
        worktreePath,
        createdAt: now(),
      };

      if (!this.config.useContainers) {
        return ok(workspace);
      }

      // Start container
      const container = await this.startContainer(workspace);
      workspace.containerId = container.id;
      this.activeContainers.set(workspaceId, container);

      return ok(workspace);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Re-attach an existing local worktree directory from a previous run so a
   * resumed run keeps editing the same files. Local mode only — container
   * mode has no durable local mount to re-attach.
   */
  async adoptWorkspace(
    workspaceId: ULID,
    worktreePath: string,
    repoPath: string,
    orphanContainerId?: string,
  ): Promise<Result<Workspace, Error>> {
    if (!existsSync(worktreePath)) {
      return err(new Error(`Checkpoint workspace no longer exists: ${worktreePath}`));
    }
    if (this.config.useContainers && orphanContainerId) {
      // The interrupted run's container is orphaned (its process died before
      // destroy ran). Reap it so resumed runs don't leak containers.
      try {
        const orphan = this.docker.getContainer(orphanContainerId);
        await orphan.remove({ force: true });
      } catch {
        // Already gone — fine.
      }
    }
    // Git worktrees carry a `.git` file pointing at the main repo; plain
    // copies (fixture repos) do not. Reconstruct the branch so a resumed run
    // can still merge its changes back the same way a fresh run would.
    const isGitWorktree = existsSync(join(worktreePath, '.git'));
    this.activeWorktrees.set(workspaceId, {
      path: worktreePath,
      branch: isGitWorktree ? `guppy-${workspaceId.slice(0, 8)}` : '',
      commit: '',
      repoPath,
    });

    const workspace: Workspace = {
      id: workspaceId,
      repoPath,
      worktreePath,
      createdAt: now(),
    };
    if (this.config.useContainers) {
      // Container mode: the crash left the host worktree on disk; start a
      // fresh container bound to the same directory so the resumed run keeps
      // editing the same files (the previous container is orphaned and
      // reaped by the next destroy; orphaned containers are also pruned on
      // the next manager's destroy of any workspace).
      try {
        const container = await this.startContainer(workspace);
        workspace.containerId = container.id;
        this.activeContainers.set(workspaceId, container);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return ok(workspace);
  }

  async destroyWorkspace(
    workspaceId: ULID,
    options: { deleteBranch?: boolean } = {},
  ): Promise<Result<void, Error>> {
    try {
      // Stop container
      const container = this.activeContainers.get(workspaceId);
      if (container) {
        await container.stop({ t: 10 });
        await container.remove();
        this.activeContainers.delete(workspaceId);
      }

      // Remove worktree
      const worktree = this.activeWorktrees.get(workspaceId);
      if (worktree) {
        await this.removeWorktree(worktree);
        if (options.deleteBranch && worktree.branch) {
          // Only safe once the worktree is gone (a branch checked out in a
          // worktree cannot be deleted). Best-effort: a leftover branch is
          // harmless and preserves the changes if the merge was partial.
          try {
            await execa('git', ['branch', '-d', worktree.branch], { cwd: worktree.repoPath });
          } catch {
            // Ignore — keep the branch rather than losing work.
          }
        }
        this.activeWorktrees.delete(workspaceId);
      }

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ---------------------------------------------------------------------------
  // Worktree Management
  // ---------------------------------------------------------------------------

  private async createWorktree(repoPath: string, workspaceId: ULID): Promise<string> {
    const worktreePath = join(this.config.worktreeBase, workspaceId);

    // Local mode without a git repo: plain directory copy. This is the
    // bench-runner path — fixtures are generated directories, not repos.
    if (!this.config.useContainers && !existsSync(join(repoPath, '.git'))) {
      mkdirSync(worktreePath, { recursive: true });
      cpSync(repoPath, worktreePath, {
        recursive: true,
        // Match on relative path segments only — substring matching would
        // exclude everything when the repo itself lives under .guppy/.
        filter: (src: string) => {
          const segments = relative(repoPath, src).split(sep);
          return !segments.includes('node_modules') && !segments.includes('.guppy');
        },
      });
      this.activeWorktrees.set(workspaceId, { path: worktreePath, branch: '', commit: '', repoPath });
      return worktreePath;
    }

    const branchName = `guppy-${workspaceId.slice(0, 8)}`;

    // Create worktree
    await execa('git', ['worktree', 'add', '-b', branchName, worktreePath], {
      cwd: repoPath,
      stdio: 'pipe',
    });

    const { stdout: commit } = await execa('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });

    const info: WorktreeInfo = {
      path: worktreePath,
      branch: branchName,
      commit: commit.trim(),
      repoPath,
    };
    this.activeWorktrees.set(workspaceId, info);

    return worktreePath;
  }

  private async removeWorktree(worktree: WorktreeInfo): Promise<void> {
    // `git worktree remove` must run from the repo that owns the worktree;
    // from any other cwd git resolves the wrong repository and leaves the
    // worktree registered, which then blocks branch deletion.
    try {
      await execa('git', ['worktree', 'remove', '--force', worktree.path], {
        cwd: worktree.repoPath,
        stdio: 'pipe',
      });
    } catch {
      // Ignore errors — the directory is removed below regardless.
    }
    if (existsSync(worktree.path)) {
      rmSync(worktree.path, { recursive: true, force: true });
    }
  }

  /**
   * Merge a finished workspace's changes back into its source repo, so a
   * successful run leaves the fix in the user's checkout instead of being
   * destroyed with the worktree.
   *
   * Git worktrees: commit the agent's edits on the workspace branch (inline
   * author config — we never depend on or modify the user's git identity),
   * then merge that branch into the repo's current branch.
   *
   * Plain copies (fixtures, non-git repos): mirror the worktree back over the
   * repo, removing files the agent deleted.
   */
  /**
   * Commit-message template for merge-back. `{task}` is replaced with the
   * task description by the session manager (which knows the task).
   */
  async mergeBack(
    workspaceId: ULID,
    options: { noCommit?: boolean; commitMessage?: string; force?: boolean } = {},
  ): Promise<Result<{ filesChanged: number }, Error>> {
    const info = this.activeWorktrees.get(workspaceId);
    if (!info) {
      return err(new Error(`Workspace not found: ${workspaceId}`));
    }

    try {
      // Git worktree: commit + merge. With `noCommit`, fall through to the
      // overlay below so the changes land in the repo uncommitted.
      if (info.branch && !options.noCommit) {
        const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: info.path });
        const filesChanged = stdout.split('\n').filter((l) => l.trim() !== '').length;
        if (filesChanged > 0) {
          await execa('git', ['add', '-A'], { cwd: info.path });
          await execa(
            'git',
            [
              '-c',
              'user.name=Guppy',
              '-c',
              'user.email=guppy@local',
              'commit',
              '-m',
              options.commitMessage ?? 'guppy: apply agent changes',
            ],
            { cwd: info.path },
          );
          await execa('git', ['merge', '--no-ff', '-m', 'guppy: merge agent work', info.branch], {
            cwd: info.repoPath,
          });
        }
        return ok({ filesChanged });
      }

      // `--no-commit` overlays the worktree over the repo as-is, which would
      // clobber any uncommitted local edits. Refuse on a dirty git repo unless
      // the caller explicitly forces it.
      if (options.noCommit && info.branch && !options.force) {
        const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: info.repoPath });
        if (stdout.trim() !== '') {
          return err(
            new Error(
              'Refusing to overlay changes onto a dirty working tree — commit or stash your changes first (or pass --force to overwrite)',
            ),
          );
        }
      }

      const filesChanged = this.mirrorDirectory(info.path, info.repoPath);
      return ok({ filesChanged });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Mirror a plain-copy worktree back over its source repo. Never touches
   * `.guppy`, `node_modules`, or `.git`; mirrors deletions so files the
   * agent removed stay removed.
   */
  private mirrorDirectory(from: string, to: string): number {
    const skip = (p: string): boolean => {
      const rel = relative(from, p);
      const segments = rel.split(sep);
      return segments.includes('node_modules') || segments.includes('.guppy') || segments.includes('.git');
    };

    let filesChanged = 0;

    // Count files that are new or whose content differs *before* copying, so
    // the copy itself can't erase the evidence of what changed.
    const countChanges = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (skip(abs)) continue;
        const counterpart = join(to, relative(from, abs));
        if (entry.isDirectory()) {
          countChanges(abs);
          continue;
        }
        if (!existsSync(counterpart) || !filesEqual(abs, counterpart)) filesChanged++;
      }
    };
    countChanges(from);

    // Copy every non-skipped entry over the destination.
    cpSync(from, to, {
      recursive: true,
      filter: (src: string) => !skip(src),
    });

    // Mirror deletions: drop destination files that no longer exist in the
    // worktree (each removed file counts as a change).
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (skip(abs)) continue;
        const counterpart = join(from, relative(to, abs));
        if (entry.isDirectory()) {
          walk(abs);
          if (!existsSync(counterpart)) {
            rmSync(abs, { recursive: true, force: true });
            filesChanged++;
          }
        } else if (!existsSync(counterpart)) {
          rmSync(abs, { force: true });
          filesChanged++;
        }
      }
    };
    walk(to);

    return filesChanged;
  }

  async mergeWorktree(workspaceId: ULID, targetBranch: string = 'main'): Promise<Result<void, Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) {
      return err(new Error('Worktree not found'));
    }

    try {
      // Commit any pending changes
      await execa('git', ['add', '-A'], { cwd: worktree.path, stdio: 'pipe' });
      await execa('git', ['commit', '-m', 'Guppy: auto-commit before merge'], { cwd: worktree.path, stdio: 'pipe' });

      // Merge into target
      await execa('git', ['checkout', targetBranch], { cwd: worktree.path, stdio: 'pipe' });
      await execa('git', ['merge', '--no-ff', worktree.branch], { cwd: worktree.path, stdio: 'pipe' });

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ---------------------------------------------------------------------------
  // Container Management
  // ---------------------------------------------------------------------------

  private async startContainer(workspace: Workspace): Promise<Docker.Container> {
    const container = await this.docker.createContainer({
      Image: this.config.dockerImage,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: '/workspace',
      HostConfig: {
        Memory: this.parseMemory(this.config.memoryLimit),
        NanoCpus: this.config.cpuLimit * 1_000_000_000,
        NetworkMode: this.config.networkMode,
        Binds: [`${workspace.worktreePath}:/workspace:rw`],
        AutoRemove: false,
      },
      Tty: false,
      OpenStdin: false,
    });

    await container.start();
    return container;
  }

  private parseMemory(mem: string): number {
    const match = mem.match(/^(\d+)([gGmM])?$/);
    if (!match || !match[1]) return 4 * 1024 * 1024 * 1024;
    const value = parseInt(match[1], 10);
    const unit = (match[2]?.toLowerCase() || 'g') as 'g' | 'm';
    const multipliers: Record<'g' | 'm', number> = { g: 1024 * 1024 * 1024, m: 1024 * 1024 };
    return value * (multipliers[unit] ?? multipliers.g);
  }

  // ---------------------------------------------------------------------------
  // Command Execution
  // ---------------------------------------------------------------------------

  async exec(workspaceId: ULID, command: string[], options: ExecOptions = {}): Promise<Result<ExecResult, Error>> {
    if (!this.config.useContainers) {
      return this.execLocal(workspaceId, command, options);
    }

    const container = this.activeContainers.get(workspaceId);
    if (!container) {
      return err(new Error('Container not found'));
    }

    const startTime = Date.now();

    try {
      const exec = await container.exec({
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: options.cwd ?? '/workspace',
        Env: options.env,
        User: options.user,
      });

      const stream = await exec.start({ hijack: true, stdin: false });
      let timer: NodeJS.Timeout | undefined;
      const run = this.readStream(stream).then((io) => io, (e: unknown) => e);
      const result = await Promise.race([
        run,
        new Promise<unknown>((resolve) => {
          timer = setTimeout(
            () => {
              // Destroy the stream so readStream settles (rejects with this
              // error) instead of leaking an open stream until the container
              // is torn down. The exec process keeps running inside the
              // sandbox; destroyWorkspace reaps it.
              stream.destroy(new Error(`container exec timed out after ${options.timeout}ms`));
              resolve(new Error(`container exec timed out after ${options.timeout}ms`));
            },
            options.timeout,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);

      if (result instanceof Error) {
        // The exec process keeps running inside the sandbox; destroyWorkspace
        // stops the container, which reaps it. Never hang the gate on it.
        return err(result);
      }
      const { stdout, stderr } = result as { stdout: string; stderr: string };

      const inspect = await exec.inspect();
      const exitCode = inspect.ExitCode ?? -1;

      return ok({
        exitCode,
        stdout,
        stderr,
        duration: Date.now() - startTime,
      });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Host-side execution for local mode. Mirrors the container exec contract. */
  private async execLocal(workspaceId: ULID, command: string[], options: ExecOptions): Promise<Result<ExecResult, Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) {
      return err(new Error('Worktree not found'));
    }

    // Map the container convention '/workspace' onto the worktree root,
    // refusing any cwd that would escape it.
    let cwd = worktree.path;
    if (options.cwd) {
      const contained = this.resolveContained(worktree.path, options.cwd);
      if (!contained) {
        return err(new Error(`cwd escapes the workspace: ${options.cwd}`));
      }
      cwd = contained;
    }

    const env: Record<string, string> | undefined = options.env
      ? Object.fromEntries(options.env.map((pair) => {
          const idx = pair.indexOf('=');
          return idx === -1 ? [pair, ''] : [pair.slice(0, idx), pair.slice(idx + 1)];
        }))
      : undefined;

    const startTime = Date.now();
    const [cmd, ...args] = command;

    try {
      const result = await execa(cmd!, args, {
        cwd,
        ...(env ? { env } : {}),
        timeout: options.timeout ?? this.config.timeout,
        reject: false,
        stdio: 'pipe',
      });

      return ok({
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        duration: Date.now() - startTime,
      });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async readStream(stream: NodeJS.ReadableStream): Promise<{ stdout: string; stderr: string }> {
    // dockerode's demuxStream never ends its PassThroughs for non-TTY execs
    // (the raw stream emits 'end', the demuxed ones don't), so accumulate the
    // raw multiplexed bytes and split frames by the 8-byte header ourselves:
    // byte 0 = stream (1 stdout / 2 stderr), bytes 4-7 = payload size (BE).
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    // The cast is purely for @types/node's generic ArrayBuffer parameter;
    // runtime-identical.
    return demuxExecFrames(
      Buffer.concat(chunks as unknown as readonly Uint8Array<ArrayBufferLike>[]),
    );
  }

  // ---------------------------------------------------------------------------
  // Path containment
  // ---------------------------------------------------------------------------

  /**
   * Resolve an agent-supplied path inside the worktree, refusing anything
   * that escapes it (`../../`, absolute paths pointing elsewhere). Also
   * maps the container convention `/workspace/...` onto the worktree root.
   * Without this, file/exec tool calls are a sandbox escape — in container
   * mode these operations touch the host-side worktree directly.
   */
  private resolveContained(worktreePath: string, agentPath: string): string | null {
    const root = resolve(worktreePath);
    const stripped = agentPath === '/workspace' ? '' : agentPath.replace(/^\/workspace\//, '');
    const resolved = resolve(root, stripped);
    if (resolved !== root && !resolved.startsWith(root + sep)) return null;

    // Symlink defense: lexical containment is not enough. A symlink the agent
    // created inside the container (e.g. `ln -s /etc /workspace/evil`) passes
    // the prefix check but points at the host's /etc, and these file tools
    // operate on the host-side worktree. Resolve the real path of the nearest
    // existing ancestor and require it to stay under the worktree root.
    try {
      const rootReal = realpathSync(root);
      let target = resolved;
      while (!existsSync(target) && target !== root) {
        const parent = dirname(target);
        if (parent === target) break;
        target = parent;
      }
      const real = realpathSync(target);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
    } catch {
      // If the real path can't be determined, refuse rather than guess.
      return null;
    }

    return resolved;
  }

  // ---------------------------------------------------------------------------
  // File Operations
  // ---------------------------------------------------------------------------

  async readFile(workspaceId: ULID, path: string): Promise<Result<string, Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) {
      return err(new Error('Worktree not found'));
    }

    const fullPath = this.resolveContained(worktree.path, path);
    if (!fullPath) {
      return err(new Error(`Path escapes the workspace: ${path}`));
    }
    try {
      const content = await import('fs/promises').then(fs => fs.readFile(fullPath, 'utf-8'));
      return ok(content);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async writeFile(workspaceId: ULID, path: string, content: string): Promise<Result<void, Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) {
      return err(new Error('Worktree not found'));
    }

    const fullPath = this.resolveContained(worktree.path, path);
    if (!fullPath) {
      return err(new Error(`Path escapes the workspace: ${path}`));
    }
    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      await import('fs/promises').then(fs => fs.writeFile(fullPath, content, 'utf-8'));
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async listFiles(workspaceId: ULID, pattern: string = '**/*'): Promise<Result<FileContent[], Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) {
      return err(new Error('Worktree not found'));
    }
    if (pattern.includes('..')) {
      return err(new Error(`Glob pattern escapes the workspace: ${pattern}`));
    }

    try {
      const glob = (await import('glob')).glob;
      const files = await glob(pattern, {
        cwd: worktree.path,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.guppy/**', '**/coverage/**'],
      });

      const MAX_FILE_SIZE = 1024 * 1024; // Skip files larger than 1MB (binaries, generated output)
      const rootPrefix = resolve(worktree.path) + sep;
      const rootReal = realpathSync(worktree.path);

      const results: FileContent[] = [];
      for (const file of files) {
        // Defense in depth: drop anything the glob resolved outside the root.
        if (!resolve(file).startsWith(rootPrefix)) continue;
        // Drop symlinks that resolve outside the worktree (host-side read).
        try {
          const real = realpathSync(file);
          if (real !== rootReal && !real.startsWith(rootReal + sep)) continue;
        } catch {
          continue;
        }
        const stat = await import('fs/promises').then(fs => fs.stat(file));
        if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;

        const content = await import('fs/promises').then(fs => fs.readFile(file, 'utf-8'));
        const relativePath = file.slice(worktree.path.length + 1);

        results.push({
          path: relativePath,
          content,
          language: this.detectLanguage(file),
          size: stat.size,
          hash: await this.hashContent(content),
        });
      }

      return ok(results);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ---------------------------------------------------------------------------
  // Search, patch, and git introspection (the "rich tools")
  // ---------------------------------------------------------------------------

  /**
   * ripgrep-backed search, constrained to the worktree (optionally a
   * subdirectory). Falls back to a plain substring scan when ripgrep isn't
   * installed, so the tool stays useful on minimal machines.
   */
  async search(
    workspaceId: ULID,
    query: string,
    options: { path?: string; glob?: string } = {},
  ): Promise<Result<string, Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) return err(new Error('Worktree not found'));
    if (query === '') return err(new Error('search requires a non-empty query'));

    let basePath = worktree.path;
    if (options.path) {
      const contained = this.resolveContained(worktree.path, options.path);
      if (!contained) return err(new Error(`Search path escapes the workspace: ${options.path}`));
      basePath = contained;
    }

    const args = [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      ...(options.glob ? ['--glob', options.glob] : []),
      '--',
      query,
      options.path ?? '.',
    ];
    try {
      const result = await execa('rg', args, { cwd: worktree.path, reject: false, stdio: 'pipe' });
      // A missing binary surfaces differently per platform. With execa v9 +
      // reject:false, POSIX resolves a spawn failure as `failed: true` with
      // no exit code (it does not throw ENOENT); Windows resolves exit 1 with
      // a shell "not recognized" message. Either way, degrade to the
      // substring scan rather than surfacing a confusing "rg failed" error.
      const missingBinary =
        (result.failed && result.exitCode === undefined) ||
        (result.exitCode === 1 &&
          result.stdout === '' &&
          /not recognized|not found|no such file|command not found/i.test(result.stderr));
      if (missingBinary) return this.fallbackSearch(worktree.path, basePath, query);
      if (result.exitCode === 0 || result.exitCode === 1) {
        return ok(result.stdout.trim() || '(no matches)');
      }
      return err(new Error(result.stderr.trim() || `rg failed (exit ${result.exitCode})`));
    } catch {
      // rg not installed (older execa throws POSIX spawn ENOENT) — degrade to
      // a substring scan.
      return this.fallbackSearch(worktree.path, basePath, query);
    }
  }

  /** Plain substring scan used when ripgrep isn't available. */
  private async fallbackSearch(worktreeRoot: string, basePath: string, query: string): Promise<Result<string, Error>> {
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await import('fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }));
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.guppy') continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        try {
          const stat = await import('fs/promises').then((fs) => fs.stat(abs));
          if (stat.size > 1024 * 1024) continue;
          const content = await import('fs/promises').then((fs) => fs.readFile(abs, 'utf-8'));
          content.split('\n').forEach((line, i) => {
            if (line.includes(query)) {
              // Forward slashes so the fallback matches rg's output on Windows.
              const rel = relative(worktreeRoot, abs).split(sep).join('/');
              results.push(`${rel}:${i + 1}:${line.trim()}`);
            }
          });
        } catch {
          // Skip unreadable files.
        }
      }
    };
    await walk(basePath);
    return ok(results.slice(0, 200).join('\n') || '(no matches)');
  }

  /**
   * Apply a unified diff to the worktree. Every file path in the patch must
   * resolve inside the worktree (path containment). Supports create / modify /
   * delete hunks via fuzzy context matching.
   */
  async applyPatch(
    workspaceId: ULID,
    patch: string,
  ): Promise<Result<{ files: Array<{ path: string; operation: 'create' | 'modify' | 'delete' }> }, Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) return err(new Error('Worktree not found'));

    const files = parseUnifiedDiff(patch);
    if (files.length === 0) return err(new Error('No files found in patch'));

    const changed: Array<{ path: string; operation: 'create' | 'modify' | 'delete' }> = [];
    try {
      for (const file of files) {
        const fullPath = this.resolveContained(worktree.path, file.path);
        if (!fullPath) return err(new Error(`Patch path escapes the workspace: ${file.path}`));

        if (file.isDelete) {
          if (existsSync(fullPath)) rmSync(fullPath, { force: true });
          changed.push({ path: file.path, operation: 'delete' });
          continue;
        }

        const existed = existsSync(fullPath);
        const original = existed
          ? await import('fs/promises').then((fs) => fs.readFile(fullPath, 'utf-8'))
          : '';
        const next = applyHunks(original, file.hunks);

        mkdirSync(dirname(fullPath), { recursive: true });
        await import('fs/promises').then((fs) => fs.writeFile(fullPath, next, 'utf-8'));
        changed.push({ path: file.path, operation: existed ? 'modify' : 'create' });
      }
      return ok({ files: changed });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** `git status --porcelain` for the worktree (git repos only). */
  async gitStatus(workspaceId: ULID): Promise<Result<string, Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) return err(new Error('Worktree not found'));
    if (!worktree.branch) return err(new Error('git_status is only available for git repositories'));
    try {
      const result = await execa('git', ['status', '--porcelain'], { cwd: worktree.path, stdio: 'pipe' });
      return ok(result.stdout.trim() || '(working tree clean)');
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** `git diff` for the worktree (git repos only). */
  async gitDiff(workspaceId: ULID): Promise<Result<string, Error>> {
    const worktree = this.activeWorktrees.get(workspaceId);
    if (!worktree) return err(new Error('Worktree not found'));
    if (!worktree.branch) return err(new Error('git_diff is only available for git repositories'));
    try {
      const result = await execa('git', ['diff'], { cwd: worktree.path, stdio: 'pipe' });
      return ok(result.stdout.trim() || '(no changes)');
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private detectLanguage(path: string): string {
    const ext = basename(path).split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      cs: 'csharp',
      cpp: 'cpp',
      c: 'c',
      h: 'c',
      hpp: 'cpp',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
      sh: 'bash',
      dockerfile: 'dockerfile',
    };
    return map[ext || ''] || 'text';
  }

  private async hashContent(content: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  async createSnapshot(workspaceId: ULID): Promise<Result<string, Error>> {
    if (!this.config.useContainers) {
      return err(new Error('Container snapshots unavailable in local mode (use git checkpoints)'));
    }

    const container = this.activeContainers.get(workspaceId);
    if (!container) {
      return err(new Error('Container not found'));
    }

    try {
      // Commit container to create snapshot
      const image = await container.commit({
        comment: `Guppy snapshot ${now()}`,
        author: 'Guppy Agent',
      });

      return ok(image.id);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async restoreSnapshot(workspaceId: ULID, imageId: string): Promise<Result<void, Error>> {
    if (!this.config.useContainers) {
      return err(new Error('Container snapshots unavailable in local mode (use git checkpoints)'));
    }

    const container = this.activeContainers.get(workspaceId);
    if (container) {
      await container.stop({ t: 5 });
      await container.remove();
    }

    try {
      // Re-mount the worktree so the restored container sees the workspace files
      const worktree = this.activeWorktrees.get(workspaceId);
      const newContainer = await this.docker.createContainer({
        Image: imageId,
        Cmd: ['sleep', 'infinity'],
        WorkingDir: '/workspace',
        HostConfig: {
          Memory: this.parseMemory(this.config.memoryLimit),
          NanoCpus: this.config.cpuLimit * 1_000_000_000,
          NetworkMode: this.config.networkMode,
          ...(worktree ? { Binds: [`${worktree.path}:/workspace:rw`] } : {}),
        },
      });

      await newContainer.start();
      this.activeContainers.set(workspaceId, newContainer);

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  getWorktreePath(workspaceId: ULID): string | undefined {
    return this.activeWorktrees.get(workspaceId)?.path;
  }

  getContainerId(workspaceId: ULID): string | undefined {
    return this.activeContainers.get(workspaceId)?.id;
  }

  /**
   * Probe whether container mode can actually run: the Docker daemon must be
   * reachable and the executor image must exist locally. Returns a plain
   * reason when not, so callers can tell the user to start Docker Desktop or
   * use --local instead of surfacing an obscure dockerode error mid-run.
   */
  async probeContainerRuntime(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.config.useContainers) return { ok: true };
    try {
      await this.docker.ping();
    } catch {
      return {
        ok: false,
        reason:
          'Docker daemon is not reachable — start Docker Desktop, or run with --local to execute on the host',
      };
    }
    try {
      await this.docker.getImage(this.config.dockerImage).inspect();
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: `Executor image ${this.config.dockerImage} not found locally — run \`docker build -t ${this.config.dockerImage} docker/executor\`, or use --local`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a docker exec's multiplexed stream into stdout/stderr. Each frame is
 * 8 header bytes (byte 0: 1=stdout 2=stderr; bytes 4-7: payload size, big
 * endian) followed by the payload.
 */
function demuxExecFrames(raw: Buffer): { stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (i + 8 > raw.length) {
      throw new Error(`truncated docker exec frame: ${raw.length - i} trailing bytes`);
    }
    const type = raw[i];
    const size = raw.readUInt32BE(i + 4);
    if (i + 8 + size > raw.length) {
      throw new Error(
        `truncated docker exec frame: expected ${size} bytes, found ${raw.length - i - 8}`,
      );
    }
    const payload = raw.subarray(i + 8, i + 8 + size).toString('utf8');
    (type === 2 ? stderr : stdout).push(payload);
    i += 8 + size;
  }
  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

/** Byte-identical files count as unchanged during a mirror. */
function filesEqual(a: string, b: string): boolean {
  try {
    const bufA = readFileSync(a);
    const bufB = readFileSync(b);
    if (bufA.length !== bufB.length) return false;
    for (let i = 0; i < bufA.length; i++) {
      if (bufA[i] !== bufB[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExecOptions {
  env?: string[];
  user?: string;
  cwd?: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkspaceManager(config: Partial<WorkspaceConfig> = {}): WorkspaceManager {
  return new WorkspaceManager(config);
}