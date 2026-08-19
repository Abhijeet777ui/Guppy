/**
 * MCP process sandboxing — the three enforceable layers between Guppy and a
 * server it spawns. This is not a true OS jail: a plain child process runs
 * with the user's account, and any claim otherwise would be a lie. What can
 * be enforced, is:
 *
 *  1. env scrubbing — API keys, tokens, and credentials never cross into the
 *     server's environment. An explicit `env` on the registration is the
 *     only way to add one back, and that is a deliberate user choice.
 *  2. cwd confinement — the server starts inside the workspace, so relative
 *     file operations stay in the repo instead of wherever the CLI happened
 *     to be launched.
 *  3. kill-on-session-end — every spawned pid is tracked, and closing the
 *     bridge force-kills the server *and its whole process tree*. A plain
 *     child kill leaves detached grandchildren alive; the tree-kill closes
 *     that hole on every exit path (normal close, process.exit, Ctrl+C).
 */

import { execFileSync } from 'node:child_process';

/** Env var names matching this are never passed to a server. */
const SENSITIVE_ENV_PATTERN = /key|token|secret|passwd|password|credential|auth/i;

/**
 * Build the environment handed to an MCP server process: the parent env minus
 * anything that looks like a credential, then the server's own registered
 * `env` on top (explicit opt-in — it can re-add anything the server
 * genuinely needs). Function-valued vars (shell code) are dropped the same
 * way the SDK's own default environment does.
 */
export function scrubEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (value.startsWith('()')) continue;
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

/** True when a process with this pid exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Force-kill one pid. On Windows this is `taskkill /T /F` — which also kills
 * the pid's own subtree in the same call; on POSIX a plain SIGKILL.
 */
export function forceKill(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // Already gone (or a zombie taskkill refuses) — nothing to do.
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Collect the descendant pids of `root` (not including root itself) via a
 * single `ps` walk. Returns [] when the platform query fails, so callers can
 * degrade to killing just the root.
 */
export function collectDescendants(root: number): number[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const all: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    for (const child of children.get(pid) ?? []) {
      all.push(child);
      stack.push(child);
    }
  }
  return all;
}

/**
 * Kill a process and everything under it. Windows: one `taskkill /T /F`
 * covers the whole tree. POSIX: SIGKILL the known descendants first, then
 * the root (the descendants must be killed by pid — once the root dies they
 * get reparented and a tree walk can no longer find them).
 */
export function killProcessTree(root: number): void {
  if (process.platform === 'win32') {
    forceKill(root);
    return;
  }
  for (const pid of collectDescendants(root)) forceKill(pid);
  forceKill(root);
}

// ---------------------------------------------------------------------------
// Process registry + kill-on-session-end guarantee
// ---------------------------------------------------------------------------
//
// `client.close()` (the SDK's) ends the direct child's stdin and escalates to
// SIGTERM/SIGKILL on it alone — grandchildren survive. The registry below is
// the belt-and-braces layer: every spawned root pid is tracked, and a
// process-level exit hook synchronously tree-kills anything still alive, so
// no exit path (including `process.exit(1)` mid-run and Ctrl+C) can orphan a
// server. `bridge.close()` untracks as it cleans up.

const tracked = new Map<number, string>();
let exitHookInstalled = false;

/** Remember a spawned server root so the exit hook can kill it if needed. */
export function trackMcpProcess(rootPid: number, serverName: string): void {
  tracked.set(rootPid, serverName);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const pid of tracked.keys()) {
        try {
          killProcessTree(pid);
        } catch {
          // Best-effort at exit: never let cleanup take the process down.
        }
      }
    });
  }
}

/** Forget a pid once its bridge has closed it. */
export function untrackMcpProcess(rootPid: number): void {
  tracked.delete(rootPid);
}
