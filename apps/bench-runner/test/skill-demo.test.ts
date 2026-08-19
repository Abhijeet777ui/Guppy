/**
 * Skill-impact demo tests — hermetic, no LLM.
 *
 * Proves the Slice 5 claim end to end: the same fixture and scripted runtime,
 * once with no skills and once with the clamp-fix skill in the context, flip
 * the real `node --test` gate. This is the deterministic counterpart of
 * `guppy-bench run --config guppy-core,guppy-core-skill`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills } from '@guppy/context-engine';
import { renderReport } from '../src/report.js';
import type { TaskRunResult } from '../src/runner.js';
import { CLAMP_SKILL_FILE, runSkillDemo, writeClampSkill } from '../src/index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir; harmless.
    }
  }
});

describe('skill-impact demo', () => {
  it('a skill in context flips the verification gate (no skill fails, skill passes)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'guppy-skill-demo-'));
    tmpDirs.push(outDir);
    // Two full fixture materialize -> workspace -> real `node --test` gate
    // cycles; give the hermetic demo room to run.
    const report = await runSkillDemo({ outDir, taskId: 'bugfix-clamp' });

    // Baseline: no skills -> the agent makes a naive edit -> gate stays red.
    expect(report.runANoSkill.gatePassed).toBe(false);
    expect(report.runANoSkill.skillInContext).toBe(false);

    // Treatment: the clamp-fix skill reaches the context -> correct fix -> green.
    expect(report.runBWithSkill.skillInContext).toBe(true);
    expect(report.runBWithSkill.gatePassed).toBe(true);
    expect(report.runBWithSkill.suiteGreen).toBe(true);

    expect(report.passed).toBe(true);
  }, 60_000);

  it('the report renders a skill-impact A/B section when both configs ran', () => {
    const mk = (config: 'guppy-core' | 'guppy-core-skill', taskId: string, passed: boolean): TaskRunResult => ({
      config,
      taskId,
      kind: 'bugfix',
      passed,
      attempts: [{ attempt: 1, wallTimeMs: 100, tokens: 100, toolCalls: 3, verified: passed }],
      wallTimeMs: 100,
      tokensTotal: 100,
      toolCalls: 3,
      fixtureDir: '/tmp/x',
      ...(passed ? {} : { error: 'gate red' }),
    });
    const results: TaskRunResult[] = [
      mk('guppy-core', 'bugfix-clamp', true),
      mk('guppy-core-skill', 'bugfix-clamp', true),
      mk('guppy-core', 'bugfix-sum', false),
      mk('guppy-core-skill', 'bugfix-sum', true),
    ];
    const report = renderReport(results, {
      outDir: '/tmp',
      configs: ['guppy-core', 'guppy-core-skill'],
      model: 'm',
      maxAttempts: 3,
      attemptTimeoutMs: 1_000,
      dryRun: false,
    });
    expect(report).toContain('## Skill impact A/B (guppy-core vs guppy-core-skill)');
    expect(report).toContain('same');
    expect(report).toContain('+1 (skill helped)');
    expect(report).toContain('+50pp'); // 50% -> 100% pass rate
  });

  it('the clamp-fix skill file is a valid, loadable skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guppy-skill-file-'));
    tmpDirs.push(dir);
    const file = writeClampSkill(dir);
    expect(file.endsWith('clamp-fix.md')).toBe(true);

    const skills = loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('clamp-fix');
    expect(skills[0]!.prompt).toContain('Math.min(Math.max(value, min), max)');
    expect(CLAMP_SKILL_FILE).toContain('name: clamp-fix');
  });
});
