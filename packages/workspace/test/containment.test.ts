import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceManager } from '../src/index.js';

describe('workspace path containment', () => {
  it('rejects a symlink that resolves outside the worktree', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guppy-ws-'));
    const repoDir = join(base, 'repo');
    const outsideDir = join(base, 'outside');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const secret = join(outsideDir, 'secret.txt');
    writeFileSync(secret, 'top secret');
    writeFileSync(join(repoDir, 'file.ts'), 'export const x = 1;\n');

    const mgr = createWorkspaceManager({ useContainers: false, worktreeBase: join(base, 'wt') });
    const ws = await mgr.createWorkspace(repoDir);
    expect(ws.ok).toBe(true);
    const worktree = ws.value.worktreePath!;

    // Plant a symlink inside the worktree pointing at a file outside it.
    // Symlink creation needs privileges on Windows, so degrade to a no-op
    // (and still pass) when the platform forbids it.
    let planted = true;
    try {
      symlinkSync(secret, join(worktree, 'evil'));
    } catch {
      planted = false;
    }

    try {
      if (planted) {
        const res = await mgr.readFile(ws.value.id, 'evil');
        // Must refuse — and if a platform race lets it through, it must not
        // have leaked the outside file's contents.
        expect(res.ok).toBe(false);
        if (res.ok) expect(res.value).not.toContain('top secret');
      }
    } finally {
      await mgr.destroyWorkspace(ws.value.id);
      rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
