/**
 * The guppy-core bench config must surface model-client errors loudly instead
 * of recording a silent 0-token failure and masking the cause with the
 * verification gate's red output — the bug that contaminated the gem-full
 * 4/20 Gemini run (STATUS.md §7 #13).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTask } from '../src/fixtures.js';
import { runSingle } from '../src/runner.js';

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

describe('guppy-core model error', () => {
  it('surfaces a model-client error loudly instead of a silent 0-token gate failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-bench-core-'));
    tmpDirs.push(dir);

    const result = await runSingle('guppy-core', getTask('bugfix-clamp')!, {
      outDir: join(dir, 'out'),
      configs: ['guppy-core'],
      model: 'fake/model',
      // Unreachable endpoint → the client throws immediately (no retries).
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'fake',
      maxRetries: 0,
      maxAttempts: 3,
      attemptTimeoutMs: 10_000,
      dryRun: false,
    });

    expect(result.passed).toBe(false);
    // The infrastructure error breaks the loop on the first attempt — retrying
    // an unreachable model endpoint is pointless and would only mask the cause.
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.errorSummary).toContain('Model request failed');
    expect(result.error).toContain('Model request failed');
    expect(result.tokensTotal).toBe(0);
  });
});
