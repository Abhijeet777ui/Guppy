/**
 * Dataset loading + materialization tests.
 *
 * Covers the SWE-bench-verified and LiveCodeBench JSONL parsers, applying a
 * test patch to a local checkout (fixture red), applying the gold patch
 * (fixture green), and running a materialized dataset task through the real
 * bench harness in dry-run mode.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLiveCodeBenchJsonl,
  parseSweBenchJsonl,
  materializeDatasetInstance,
  applyPatchToDir,
  loadDataset,
  datasetInstanceToBenchTask,
} from '../src/datasets.js';
import { writeBaseFiles, runTestSuite, selectTasks } from '../src/fixtures.js';
import { runBench, type BenchOptions } from '../src/runner.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir; harmless.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-dataset-'));
  tmpDirs.push(dir);
  return dir;
}

const SWE_LINE = JSON.stringify({
  instance_id: 'fixture__fixture-1',
  repo: 'fixture/fixture',
  base_commit: 'abc123',
  problem_statement: 'The test suite fails: sum is off by a constant.',
  patch: 'gold patch',
  test_patch: 'test patch',
  FAIL_TO_PASS: ['test/dataset.test.ts'],
  PASS_TO_PASS: [],
});

const LCB_LINE = JSON.stringify({
  question_id: 'lcb-1',
  question: 'Implement a function that doubles a number.',
  test_code: 'def check(sol): assert sol(2) == 4',
  difficulty: 'easy',
});

describe('parseSweBenchJsonl', () => {
  it('parses valid lines with all fields', () => {
    const instances = parseSweBenchJsonl(`${SWE_LINE}\n`);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      id: 'fixture__fixture-1',
      description: 'The test suite fails: sum is off by a constant.',
      testPatch: 'test patch',
      patch: 'gold patch',
      repo: 'fixture/fixture',
      baseCommit: 'abc123',
      source: 'swe-bench',
    });
  });

  it('skips malformed lines and respects the limit', () => {
    const text = ['not json', SWE_LINE, SWE_LINE, SWE_LINE].join('\n');
    expect(parseSweBenchJsonl(text, 2)).toHaveLength(2);
    expect(parseSweBenchJsonl(text)).toHaveLength(3);
  });

  it('drops lines missing required fields', () => {
    const bad = JSON.stringify({ instance_id: 'x', problem_statement: 'p' }); // no test_patch
    expect(parseSweBenchJsonl(`${bad}\n${SWE_LINE}\n`)).toHaveLength(1);
  });
});

describe('parseLiveCodeBenchJsonl', () => {
  it('maps question_id/question/test_code', () => {
    const instances = parseLiveCodeBenchJsonl(`${LCB_LINE}\n`);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      id: 'lcb-1',
      description: 'Implement a function that doubles a number.',
      testPatch: 'def check(sol): assert sol(2) == 4',
      source: 'livecodebench',
    });
  });
});

// Synthetic SWE-bench-shaped instance against the hermetic base repo: the
// test patch adds a suite importing a function the base repo lacks (red),
// and the gold patch adds that function (green).
const TEST_PATCH = `diff --git a/test/dataset.test.ts b/test/dataset.test.ts
new file mode 100644
--- /dev/null
+++ b/test/dataset.test.ts
@@ -0,0 +1,9 @@
+import { test } from 'node:test';
+import assert from 'node:assert/strict';
+import { difference } from '../src/math-utils.ts';
+
+test('difference subtracts the second number from the first', () => {
+  assert.equal(difference(10, 4), 6);
+  assert.equal(difference(0, 0), 0);
+});
`;

const GOLD_PATCH = `diff --git a/src/math-utils.ts b/src/math-utils.ts
--- a/src/math-utils.ts
+++ b/src/math-utils.ts
@@ -5,7 +5,11 @@ export function sum(values: number[]): number {
   return values.reduce((acc, v) => acc + v, 0);
 }
 
+export function difference(a: number, b: number): number {
+  return a - b;
+}
+
 export function average(values: number[]): number {
`;

const DATASET_JSONL = [
  JSON.stringify({
    instance_id: 'fixture__difference',
    repo: 'fixture/fixture',
    base_commit: 'base',
    problem_statement:
      'The test suite fails: src/math-utils.ts is missing the difference function. Run npm test to reproduce, then add it so the whole suite passes.',
    patch: GOLD_PATCH,
    test_patch: TEST_PATCH,
    FAIL_TO_PASS: ['test/dataset.test.ts'],
  }),
].join('\n');

describe('materializeDatasetInstance', () => {
  it('test patch alone leaves the fixture red; gold patch makes it green', async () => {
    const dir = tempDir();
    const repoDir = join(dir, 'repo');
    writeBaseFiles(repoDir);

    const instance = parseSweBenchJsonl(DATASET_JSONL, 1)[0]!;

    const redDir = join(dir, 'red');
    materializeDatasetInstance(instance, repoDir, redDir);
    const redGate = await runTestSuite(redDir, 60_000);
    expect(redGate.passed).toBe(false);
    expect(existsSync(join(redDir, 'test', 'dataset.test.ts'))).toBe(true);

    // Apply the gold patch on top → the new function exists → suite green.
    applyPatchToDir(GOLD_PATCH, redDir);
    const greenGate = await runTestSuite(redDir, 60_000);
    expect(greenGate.passed).toBe(true);
  });

  it('round-trips through loadDataset into bench tasks', () => {
    const dir = tempDir();
    const repoDir = join(dir, 'repo');
    writeBaseFiles(repoDir);
    const jsonlPath = join(dir, 'instances.jsonl');
    writeFileSync(jsonlPath, DATASET_JSONL, 'utf8');

    const outDir = join(dir, 'out');
    const tasks = loadDataset({ source: 'swe-bench', path: jsonlPath, repoDir, outDir, count: 1 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('fixture__difference');
    expect(tasks[0]!.fixtureDir).toBe(join(outDir, 'fixtures', 'dataset', 'fixture__difference'));
    expect(existsSync(tasks[0]!.fixtureDir!)).toBe(true);
  });

  it('datasetInstanceToBenchTask carries the problem statement verbatim', () => {
    const dir = tempDir();
    const instance = parseSweBenchJsonl(DATASET_JSONL, 1)[0]!;
    const task = datasetInstanceToBenchTask(instance, join(dir, 'fixture'));
    expect(task.kind).toBe('bugfix');
    expect(task.description).toContain('missing the difference function');
    expect(task.mutations).toEqual([]);
  });
});

describe('dataset tasks through the real bench harness', () => {
  it('dry-run materializes, gates red, and reports without an LLM', async () => {
    const dir = tempDir();
    const repoDir = join(dir, 'repo');
    writeBaseFiles(repoDir);
    const jsonlPath = join(dir, 'instances.jsonl');
    writeFileSync(jsonlPath, DATASET_JSONL, 'utf8');

    const outDir = join(dir, 'out');
    const tasks = loadDataset({ source: 'swe-bench', path: jsonlPath, repoDir, outDir, count: 1 });

    const options: BenchOptions = {
      outDir,
      configs: ['guppy-core'],
      tasks,
      model: 'fake/model',
      maxAttempts: 1,
      attemptTimeoutMs: 60_000,
      dryRun: true,
    };
    const results = await runBench(options);

    expect(results).toHaveLength(1);
    expect(results[0]!.taskId).toBe('fixture__difference');
    expect(results[0]!.passed).toBe(false); // fixture is red — expected in dry-run
    expect(results[0]!.error).toContain('dry-run');
    // The builtin suite still works alongside (selectTasks untouched).
    expect(selectTasks(['bugfix-clamp']).map((t) => t.id)).toEqual(['bugfix-clamp']);
  });
});
