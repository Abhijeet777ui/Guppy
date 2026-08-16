/**
 * The bench's prime configs must point at the in-repo prime-agent bundle and
 * must fail loudly when prime-agent cannot be launched — never record a
 * silent 0-token failure that hides the real cause.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTask } from '../src/fixtures.js';
import { resolvePrimeBinary, runSingle } from '../src/runner.js';

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

describe('resolvePrimeBinary', () => {
  it('resolves the in-repo prime-agent bundle', () => {
    const bin = resolvePrimeBinary();
    expect(bin).not.toBe('prime-agent');
    expect(bin).toMatch(/prime-agent[\\/]packages[\\/]coding-agent[\\/]dist[\\/]bundle[\\/]cli\.js$/);
    expect(existsSync(bin)).toBe(true);
  });
});

describe('guppy-prime spawn failure', () => {
  it('surfaces the launch error loudly instead of a silent 0-token failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-bench-prime-'));
    tmpDirs.push(dir);

    const result = await runSingle('guppy-prime', getTask('bugfix-clamp')!, {
      outDir: join(dir, 'out'),
      configs: ['guppy-prime'],
      model: 'fake/nemotron',
      // A binary that cannot spawn: the runtime returns err, which the closed
      // loop must record loudly and not retry into silence.
      primeBinary: join(dir, 'does-not-exist', 'prime-agent'),
      maxAttempts: 3,
      attemptTimeoutMs: 10_000,
      dryRun: false,
    });

    expect(result.passed).toBe(false);
    // The hard failure breaks the loop on the first attempt — retrying a
    // missing binary is pointless.
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.errorSummary).toContain('Failed to launch prime-agent');
    expect(result.error).toContain('Failed to launch prime-agent');
    expect(result.tokensTotal).toBe(0);
  });
});
