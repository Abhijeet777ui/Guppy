/**
 * Standard benchmark dataset loading — SWE-bench-verified and LiveCodeBench
 * JSONL — plus fixture materialization.
 *
 * A dataset instance is turned into a BenchTaskSpec whose fixture is the
 * *local checkout* of the repo with the instance's `test_patch` applied on
 * top: the patch seeds the failing tests the agent must make pass, and the
 * problem statement becomes the task description. The gold `patch` is kept
 * for validation (a sanity gate can prove test_patch=red / patch=green).
 *
 * Honest constraints, documented rather than hidden:
 * - Materialization needs a local checkout of the repo at (or after) the
 *   instance's base_commit — the loader never clones or builds.
 * - The bench gate runs `npm test` (or the configured suite command) in the
 *   worktree. SWE-bench / LiveCodeBench instances are overwhelmingly Python
 *   pytest suites, so running them end-to-end needs a pytest-capable gate,
 *   which is future work; the loader itself is format-correct for both.
 * - LiveCodeBench instances are self-contained (question + test_code, no
 *   repo); those materialize from the instance alone into a scratch repo.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { applyHunks, parseUnifiedDiff } from '@guppy/workspace';
import type { BenchTaskSpec } from './fixtures.js';

export type DatasetSource = 'swe-bench' | 'livecodebench';

export interface DatasetInstance {
  id: string;
  /** Problem statement handed to the agent verbatim. */
  description: string;
  /** Unified-diff test patch applied on top of the repo checkout. */
  testPatch: string;
  /** Gold solution patch (kept for validation, not given to the agent). */
  patch?: string;
  repo?: string;
  baseCommit?: string;
  source: DatasetSource;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse SWE-bench-verified JSONL. Each line:
 *   { instance_id, repo, base_commit, problem_statement, patch, test_patch,
 *     FAIL_TO_PASS, PASS_TO_PASS, ... }
 * Malformed lines are skipped; `limit` caps the returned instances.
 */
export function parseSweBenchJsonl(text: string, limit?: number): DatasetInstance[] {
  const instances: DatasetInstance[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof record['instance_id'] === 'string' ? record['instance_id'] : undefined;
    const description =
      typeof record['problem_statement'] === 'string' ? record['problem_statement'] : undefined;
    const testPatch = typeof record['test_patch'] === 'string' ? record['test_patch'] : undefined;
    if (!id || !description || !testPatch) continue;

    instances.push({
      id,
      description,
      testPatch,
      ...(typeof record['patch'] === 'string' ? { patch: record['patch'] } : {}),
      ...(typeof record['repo'] === 'string' ? { repo: record['repo'] } : {}),
      ...(typeof record['base_commit'] === 'string' ? { baseCommit: record['base_commit'] } : {}),
      source: 'swe-bench',
    });
    if (limit !== undefined && instances.length >= limit) break;
  }
  return instances;
}

/**
 * Parse LiveCodeBench JSONL. Each line:
 *   { question_id, question, test_code, starter_code?, difficulty?, ... }
 * The question is the task description; test_code is the grading harness.
 */
export function parseLiveCodeBenchJsonl(text: string, limit?: number): DatasetInstance[] {
  const instances: DatasetInstance[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof record['question_id'] === 'string' ? record['question_id'] : undefined;
    const description = typeof record['question'] === 'string' ? record['question'] : undefined;
    const testPatch = typeof record['test_code'] === 'string' ? record['test_code'] : undefined;
    if (!id || !description || !testPatch) continue;

    instances.push({ id, description, testPatch, source: 'livecodebench' });
    if (limit !== undefined && instances.length >= limit) break;
  }
  return instances;
}

/** Parse a dataset JSONL file by source. */
export function parseDatasetFile(path: string, source: DatasetSource, limit?: number): DatasetInstance[] {
  const text = readFileSync(path, 'utf8');
  return source === 'swe-bench' ? parseSweBenchJsonl(text, limit) : parseLiveCodeBenchJsonl(text, limit);
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/** Copy a repo checkout into a fixture dir, stripping heavy/irrelevant dirs. */
function copyRepo(repoDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  cpSync(repoDir, destDir, {
    recursive: true,
    filter: (src: string) => {
      const segments = relative(repoDir, src).split(sep);
      return (
        !segments.includes('node_modules') &&
        !segments.includes('.guppy') &&
        !segments.includes('.git') &&
        !segments.includes('__pycache__')
      );
    },
  });
}

/** Apply a unified-diff test patch to files in a directory tree. */
export function applyPatchToDir(patch: string, dir: string): void {
  const files = parseUnifiedDiff(patch);
  if (files.length === 0) {
    throw new Error('patch contains no file hunks');
  }
  for (const file of files) {
    const abs = join(dir, file.path);
    if (file.isDelete) {
      rmSync(abs, { force: true });
      continue;
    }
    let original = '';
    if (!file.isNew && existsSync(abs)) {
      original = readFileSync(abs, 'utf8');
    }
    const updated = applyHunks(original, file.hunks);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, updated, 'utf8');
  }
}

/**
 * Materialize a dataset instance into a fixture directory: copy the local
 * checkout (repoDir) and apply the instance's test patch. For
 * livecodebench, repoDir may be an empty scratch dir — the instance's
 * test_code patch must provide everything.
 */
export function materializeDatasetInstance(instance: DatasetInstance, repoDir: string, destDir: string): void {
  rmSync(destDir, { recursive: true, force: true });
  copyRepo(repoDir, destDir);
  applyPatchToDir(instance.testPatch, destDir);
}

/** Wrap a materialized instance as a bench task (bugfix kind, no mutations). */
export function datasetInstanceToBenchTask(instance: DatasetInstance, fixtureDir: string): BenchTaskSpec {
  return {
    id: instance.id,
    kind: 'bugfix',
    description: instance.description,
    mutations: [],
    fixtureDir,
  };
}

/**
 * Load a dataset file and materialize every selected instance into fixtures.
 * Returns bench tasks ready for runBench. Throws when the dataset or repo
 * path is unusable or no instances parse.
 */
export function loadDataset(options: {
  source: DatasetSource;
  path: string;
  repoDir: string;
  outDir: string;
  count?: number;
}): BenchTaskSpec[] {
  const instances = parseDatasetFile(options.path, options.source, options.count);
  if (instances.length === 0) {
    throw new Error(`no ${options.source} instances parsed from ${options.path}`);
  }
  if (!existsSync(options.repoDir)) {
    throw new Error(`repo checkout not found: ${options.repoDir}`);
  }

  const tasks: BenchTaskSpec[] = [];
  for (const instance of instances) {
    const fixtureDir = join(options.outDir, 'fixtures', 'dataset', instance.id);
    materializeDatasetInstance(instance, options.repoDir, fixtureDir);
    tasks.push(datasetInstanceToBenchTask(instance, fixtureDir));
  }
  return tasks;
}
