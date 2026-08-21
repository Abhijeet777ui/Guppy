/**
 * Postbuild bin-shim repair (run from the repo root via `pnpm postbuild`).
 *
 * pnpm creates dependency bin shims at install time. On a fresh checkout
 * `dist/` does not exist yet, so the shims for workspace deps whose bins
 * point at `dist/cli.js` (guppy-bench, sleep-cycle) fail with ENOENT — and
 * pnpm never retries them, even after `pnpm build` produces the target.
 * Fix: when those shims are missing, force a full offline re-link
 * (`rm -rf node_modules && pnpm install --offline`); the store is warm from
 * the original install, and now `dist/` exists so the shims get created.
 *
 * When the shims are present (the normal incremental case), this is a no-op.
 */
import { existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SHIMS = [
  'apps/control-plane/node_modules/.bin/guppy-bench',
  'apps/bench-runner/node_modules/.bin/sleep-cycle',
];

const missing = SHIMS.filter((p) => !existsSync(p));

if (missing.length === 0) {
  console.log('[relink-bins] shims present, nothing to do');
  process.exit(0);
}

console.log('[relink-bins] missing shims:', missing.join(', '));
console.log('[relink-bins] forcing offline re-link (rm -rf node_modules && pnpm install --offline)');
rmSync('node_modules', { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
execSync('pnpm install --offline', { stdio: 'inherit', shell: process.platform === 'win32' });
console.log('[relink-bins] done');
