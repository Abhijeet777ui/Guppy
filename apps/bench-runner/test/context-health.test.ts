/**
 * ContextOps bridge — the aggregation must be deterministic and the scoring
 * must degrade gracefully when Python/ContextOps is unavailable, never
 * failing the bench over a missing telemetry dependency.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateCaptures,
  analyzeContextCaptures,
  attachContextHealth,
  type CaptureAnalysis,
} from '../src/context-health.js';

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

function capture(score: number, ciStatus: string, wasted = 10, saved = 0): CaptureAnalysis {
  return {
    file: 'x.json',
    score,
    ciStatus,
    totalTokens: 100,
    wastedTokens: wasted,
    totalPenalty: 100 - score,
    tokensSaved: saved,
    tool: 'contextops@0.3.4',
  };
}

describe('aggregateCaptures', () => {
  it('averages scores, reports the worst CI status, and sums wasted/saved tokens', () => {
    const summary = aggregateCaptures([
      capture(80, 'PASS', 10, 5),
      capture(60, 'WARN', 30, 15),
      capture(40, 'FAIL', 60, 30),
    ]);
    expect(summary.files).toBe(3);
    expect(summary.scoreMin).toBe(40);
    expect(summary.scoreMax).toBe(80);
    expect(summary.scoreAvg).toBe(60);
    expect(summary.ciStatus).toBe('FAIL');
    expect(summary.wastedTokens).toBe(100);
    expect(summary.tokensSaved).toBe(50);
    expect(summary.tool).toBe('contextops@0.3.4');
  });

  it('returns an empty summary for no captures', () => {
    const summary = aggregateCaptures([]);
    expect(summary.files).toBe(0);
    expect(summary.ciStatus).toBe('n/a');
    expect(summary.wastedTokens).toBe(0);
    expect(summary.tokensSaved).toBe(0);
  });
});

describe('analyzeContextCaptures', () => {
  it('returns null when the capture directory does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-contextops-'));
    tmpDirs.push(dir);
    expect(await analyzeContextCaptures(join(dir, 'missing'))).toBeNull();
  });

  it('skips gracefully with a reason when Python is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-contextops-'));
    tmpDirs.push(dir);
    const captureDir = join(dir, 'capture');
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, 'turn-1.json'), JSON.stringify({ model: 'x', messages: [], tools: [] }));

    const summary = await analyzeContextCaptures(captureDir, join(dir, 'no-such-python'));
    expect(summary).not.toBeNull();
    expect(summary!.skipped).toBe(true);
    expect(summary!.reason).toBeTruthy();
    expect(summary!.files).toBe(1);
  });
});

describe('attachContextHealth', () => {
  it('leaves results untouched when nothing was captured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-contextops-'));
    tmpDirs.push(dir);
    const results = [{ config: 'guppy-core', taskId: 'bugfix-clamp' }];
    await attachContextHealth(results, { outDir: join(dir, 'out') });
    expect(results[0]!.contextHealth).toBeUndefined();
  });
});
