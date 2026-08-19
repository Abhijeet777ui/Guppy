/**
 * Hermetic check that the `guppy-core` bench config is fully wired: the
 * closed-loop path materializes the fixture, creates the native core runtime,
 * runs the gate, and cleans up — all in dry-run mode (no LLM, no network).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTask } from '../src/fixtures.js';
import {
  coreModelConfig,
  effectiveRetrySettings,
  runSingle,
  type BenchOptions,
} from '../src/runner.js';

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

describe('guppy-core bench config', () => {
  it('wires the closed loop in dry-run mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-bench-core-'));
    tmpDirs.push(dir);

    const result = await runSingle('guppy-core', getTask('bugfix-clamp')!, {
      outDir: join(dir, 'out'),
      configs: ['guppy-core'],
      model: 'fake/nemotron',
      provider: 'fake',
      maxAttempts: 2,
      attemptTimeoutMs: 10_000,
      dryRun: true,
    });

    expect(result.config).toBe('guppy-core');
    expect(result.taskId).toBe('bugfix-clamp');
    expect(result.kind).toBe('bugfix');
    // Dry-run never invokes an LLM; it gates the mutated fixture.
    expect(result.error).toContain('dry-run: fixture red as expected');
    expect(result.attempts).toEqual([]);
  });
});

describe('guppy-core-skill bench config', () => {
  it('routes to the core runtime (not prime) — skills swap, engine stays the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-bench-skillcfg-'));
    tmpDirs.push(dir);

    // Against an unreachable endpoint the CORE runtime fails with a loud
    // model-client error; the prime runtime would fail with a spawn error.
    // This pins the routing: `guppy-core-skill` is guppy-core + injected
    // skills, never the prime baseline (a regression that silently turned
    // the A/B into core-vs-prime).
    const result = await runSingle('guppy-core-skill', getTask('bugfix-clamp')!, {
      outDir: join(dir, 'out'),
      configs: ['guppy-core-skill'],
      model: 'fake/model',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'fake',
      maxRetries: 0,
      maxAttempts: 3,
      attemptTimeoutMs: 10_000,
      dryRun: false,
      // Compression knobs must thread through to the core runtime too.
      maxHistoryTokens: 4_000,
      historyKeepRecentTurns: 1,
    });

    expect(result.config).toBe('guppy-core-skill');
    expect(result.passed).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.error).toContain('Model request failed');
  });
});

describe('coreModelConfig', () => {
  const base: BenchOptions = {
    outDir: 'x',
    configs: ['guppy-core'],
    model: 'fake/nemotron',
    maxAttempts: 1,
    attemptTimeoutMs: 1,
    dryRun: true,
  };

  it('defaults the provider and omits retry knobs when unset', () => {
    const cfg = coreModelConfig(base);
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('fake/nemotron');
    expect(cfg.maxRetries).toBeUndefined();
    expect(cfg.retryBaseDelayMs).toBeUndefined();
    expect(cfg.retryMaxDelayMs).toBeUndefined();
  });

  it('threads retry/backoff options into the core model config', () => {
    const cfg = coreModelConfig({
      ...base,
      provider: 'openrouter',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      maxRetries: 5,
      retryBaseDelayMs: 250,
      retryMaxDelayMs: 10_000,
    });
    expect(cfg.provider).toBe('openrouter');
    expect(cfg.baseUrl).toBe('https://example.test/v1');
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.maxRetries).toBe(5);
    expect(cfg.retryBaseDelayMs).toBe(250);
    expect(cfg.retryMaxDelayMs).toBe(10_000);
  });
});

describe('effectiveRetrySettings', () => {
  const base: BenchOptions = {
    outDir: 'x',
    configs: ['guppy-core'],
    model: 'fake/nemotron',
    maxAttempts: 1,
    attemptTimeoutMs: 1,
    dryRun: true,
  };

  it('falls back to the client defaults when unset', () => {
    expect(effectiveRetrySettings(base)).toEqual({
      maxRetries: 2,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
    });
  });

  it('reflects explicit overrides, including zero retries', () => {
    expect(
      effectiveRetrySettings({
        ...base,
        maxRetries: 0,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 5000,
      }),
    ).toEqual({ maxRetries: 0, baseDelayMs: 100, maxDelayMs: 5000 });
  });
});
