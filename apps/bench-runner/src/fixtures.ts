/**
 * Guppy Bench — hermetic fixtures.
 *
 * Every task runs against a freshly generated copy of a small TypeScript
 * repo with zero npm dependencies. Tests use node:test + node:assert and
 * run via `node --test test/` (Node >= 23 native type stripping), so the
 * ground-truth gate needs no installs and no network.
 *
 * Task kinds:
 *  - bugfix:   a seeded defect in src/ breaks the suite
 *  - test-add: a test file is replaced with a failing TODO placeholder
 *  - refactor: a symbol is renamed in src/ only, leaving tests broken
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskKind = 'bugfix' | 'test-add' | 'refactor';

export interface Mutation {
  /** Repo-relative file to mutate. */
  file: string;
  /** Exact substring to locate. Ignored when wholeFile is set. */
  find: string;
  /** Replacement text (or full file content when wholeFile is set). */
  replace: string;
  /** Replace the entire file content instead of a substring. */
  wholeFile?: boolean;
}

export interface BenchTaskSpec {
  id: string;
  kind: TaskKind;
  /** Prompt handed to the agent verbatim (raw config) or via context packing. */
  description: string;
  mutations: Mutation[];
  /** Optional acceptance check beyond "the suite passes". */
  finalCheck?: (read: (relPath: string) => string | null) => boolean;
  /**
   * Pre-materialized fixture directory (dataset imports). When set, the
   * runner uses it as-is instead of writing base files + mutations.
   */
  fixtureDir?: string;
}

export interface GateResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

export interface SanityReport {
  taskId: string;
  cleanPassed: boolean;
  mutatedFailed: boolean;
  ok: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Base fixture repo (zero-dependency, node:test only)
// ---------------------------------------------------------------------------

const PACKAGE_JSON = `{
  "name": "guppy-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.ts"
  }
}
`;

const MATH_UTILS = String.raw`export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

export function average(values: number[]): number {
  if (values.length === 0) throw new Error('average of empty array');
  return sum(values) / values.length;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
`;

const STRING_UTILS = String.raw`export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
}

export function truncate(text: string, maxLength: number, suffix = '...'): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length) + suffix;
}

export function capitalizeWords(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isPalindrome(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === [...normalized].reverse().join('');
}
`;

const COLLECTIONS = String.raw`export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

export function uniqueBy<T>(items: T[], key: (item: T) => unknown): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function pluck<T, K extends keyof T>(items: T[], key: K): T[K][] {
  return items.map((item) => item[key]);
}
`;

const MATH_TESTS = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, sum, average, median, roundTo } from '../src/math-utils.ts';

test('clamp keeps values inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});

test('sum adds all values', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
  assert.equal(sum([-1, 1]), 0);
});

test('average computes the mean', () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([10]), 10);
  assert.throws(() => average([]));
});

test('median finds the middle value', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([10, 2, 33]), 10);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('roundTo rounds to decimal places', () => {
  assert.equal(roundTo(1.2345, 2), 1.23);
  assert.equal(roundTo(9.876, 1), 9.9);
  assert.equal(roundTo(5, 3), 5);
});
`;

const STRING_TESTS = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, truncate, capitalizeWords, isPalindrome } from '../src/string-utils.ts';

test('slugify converts text to url slugs', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Multi   Word Title  '), 'multi-word-title');
  assert.equal(slugify('Price: $19.99!'), 'price-1999');
});

test('truncate shortens long text with a suffix', () => {
  assert.equal(truncate('abcdefgh', 6), 'abc...');
  assert.equal(truncate('short', 10), 'short');
});

test('capitalizeWords capitalizes every word', () => {
  assert.equal(capitalizeWords('hello world'), 'Hello World');
  assert.equal(capitalizeWords('the quick brown fox'), 'The Quick Brown Fox');
});

test('isPalindrome ignores case and punctuation', () => {
  assert.equal(isPalindrome('RaceCar'), true);
  assert.equal(isPalindrome('A man, a plan, a canal: Panama'), true);
  assert.equal(isPalindrome('guppy'), false);
});
`;

const COLLECTIONS_TESTS = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupBy, uniqueBy, chunk, pluck } from '../src/collections.ts';

test('groupBy groups items by key', () => {
  const items = [
    { k: 'a', v: 1 },
    { k: 'b', v: 2 },
    { k: 'a', v: 3 },
  ];
  assert.deepEqual(groupBy(items, (i) => i.k), {
    a: [
      { k: 'a', v: 1 },
      { k: 'a', v: 3 },
    ],
    b: [{ k: 'b', v: 2 }],
  });
});

test('uniqueBy keeps the first item per key', () => {
  assert.deepEqual(uniqueBy([1, 2, 3, 4], (n) => n % 2), [1, 2]);
});

test('chunk splits arrays into groups', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

test('pluck extracts a field from every item', () => {
  assert.deepEqual(
    pluck([{ id: 'x' }, { id: 'y' }], 'id'),
    ['x', 'y'],
  );
});
`;

const TODO_TEST_PLACEHOLDER = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';

test('TODO: test suite not written yet', () => {
  assert.fail('tests for this module have not been written yet');
});
`;

/** Repo-relative path -> content, before any task mutation. */
export const BASE_FILES: Record<string, string> = {
  'package.json': PACKAGE_JSON,
  'src/math-utils.ts': MATH_UTILS,
  'src/string-utils.ts': STRING_UTILS,
  'src/collections.ts': COLLECTIONS,
  'test/math-utils.test.ts': MATH_TESTS,
  'test/string-utils.test.ts': STRING_TESTS,
  'test/collections.test.ts': COLLECTIONS_TESTS,
};

// ---------------------------------------------------------------------------
// Task catalog — 10 bugfix, 5 test-add, 5 refactor
// ---------------------------------------------------------------------------

const DO_NOT_TOUCH_TESTS =
  ' Do not modify anything under test/. The tests are correct; the source is not.';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export const BENCH_TASKS: BenchTaskSpec[] = [
  // --- bugfix (seeded defects) ---------------------------------------------
  {
    id: 'bugfix-clamp',
    kind: 'bugfix',
    description:
      'The test suite fails: `clamp` no longer keeps values inside the requested range. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      {
        file: 'src/math-utils.ts',
        find: 'Math.min(Math.max(value, min), max)',
        replace: 'Math.max(Math.min(value, min), max)',
      },
    ],
  },
  {
    id: 'bugfix-sum',
    kind: 'bugfix',
    description:
      'The test suite fails: `sum` returns totals that are off by a constant amount. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      { file: 'src/math-utils.ts', find: 'acc + v, 0)', replace: 'acc + v, 1)' },
    ],
  },
  {
    id: 'bugfix-average',
    kind: 'bugfix',
    description:
      'The test suite fails: `average` returns values that are slightly too small. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      {
        file: 'src/math-utils.ts',
        find: 'sum(values) / values.length',
        replace: 'sum(values) / (values.length + 1)',
      },
    ],
  },
  {
    id: 'bugfix-median',
    kind: 'bugfix',
    description:
      'The test suite fails: `median` returns the wrong middle value for some inputs. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      {
        file: 'src/math-utils.ts',
        find: 'sort((a, b) => a - b)',
        replace: 'sort()',
      },
    ],
  },
  {
    id: 'bugfix-roundto',
    kind: 'bugfix',
    description:
      'The test suite fails: `roundTo` rounds to the wrong number of decimal places. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      { file: 'src/math-utils.ts', find: '10 ** places', replace: '10 ** (places + 1)' },
    ],
  },
  {
    id: 'bugfix-slugify',
    kind: 'bugfix',
    description:
      'The test suite fails: `slugify` produces slugs with the wrong separator character. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      {
        file: 'src/string-utils.ts',
        find: String.raw`.replace(/\s+/g, '-')`,
        replace: String.raw`.replace(/\s+/g, '_')`,
      },
    ],
  },
  {
    id: 'bugfix-truncate',
    kind: 'bugfix',
    description:
      'The test suite fails: `truncate` returns strings longer than the requested maximum. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      {
        file: 'src/string-utils.ts',
        find: 'text.slice(0, maxLength - suffix.length) + suffix',
        replace: 'text.slice(0, maxLength) + suffix',
      },
    ],
  },
  {
    id: 'bugfix-is-palindrome',
    kind: 'bugfix',
    description:
      'The test suite fails: `isPalindrome` rejects inputs that should be palindromes. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      {
        file: 'src/string-utils.ts',
        find: String.raw`const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');`,
        replace: String.raw`const normalized = text.replace(/[^a-zA-Z0-9]/g, '');`,
      },
    ],
  },
  {
    id: 'bugfix-groupby',
    kind: 'bugfix',
    description:
      'The test suite fails: `groupBy` loses items when several share the same key. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      {
        file: 'src/collections.ts',
        find: String.raw`const k = key(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);`,
        replace: String.raw`const k = key(item);
    out[k] = [item];`,
      },
    ],
  },
  {
    id: 'bugfix-chunk',
    kind: 'bugfix',
    description:
      'The test suite fails: `chunk` drops elements from every group. Run `npm test` to reproduce, then fix the bug in src/ so the whole suite passes.' +
      DO_NOT_TOUCH_TESTS,
    mutations: [
      {
        file: 'src/collections.ts',
        find: 'out.push(items.slice(i, i + size));',
        replace: 'out.push(items.slice(i, i + size - 1));',
      },
    ],
  },

  // --- test-add (missing suites must be written) ---------------------------
  {
    id: 'testadd-math-utils',
    kind: 'test-add',
    description:
      'The test file test/math-utils.test.ts currently contains only a failing placeholder. Replace it with a real node:test suite that covers `clamp`, `sum`, and `average` from src/math-utils.ts (multiple cases each). `npm test` must pass. Do not modify anything under src/.',
    mutations: [
      { file: 'test/math-utils.test.ts', find: '', replace: TODO_TEST_PLACEHOLDER, wholeFile: true },
    ],
    finalCheck: (read) => {
      const content = read('test/math-utils.test.ts');
      return content !== null && countOccurrences(content, 'test(') >= 3;
    },
  },
  {
    id: 'testadd-median-roundto',
    kind: 'test-add',
    description:
      'The test file test/math-utils.test.ts currently contains only a failing placeholder. Replace it with a real node:test suite that covers `median` and `roundTo` from src/math-utils.ts, including odd/even length inputs for `median`. `npm test` must pass. Do not modify anything under src/.',
    mutations: [
      { file: 'test/math-utils.test.ts', find: '', replace: TODO_TEST_PLACEHOLDER, wholeFile: true },
    ],
    finalCheck: (read) => {
      const content = read('test/math-utils.test.ts');
      return content !== null && countOccurrences(content, 'test(') >= 2;
    },
  },
  {
    id: 'testadd-string-utils',
    kind: 'test-add',
    description:
      'The test file test/string-utils.test.ts currently contains only a failing placeholder. Replace it with a real node:test suite that covers `slugify` and `truncate` from src/string-utils.ts. `npm test` must pass. Do not modify anything under src/.',
    mutations: [
      { file: 'test/string-utils.test.ts', find: '', replace: TODO_TEST_PLACEHOLDER, wholeFile: true },
    ],
    finalCheck: (read) => {
      const content = read('test/string-utils.test.ts');
      return content !== null && countOccurrences(content, 'test(') >= 2;
    },
  },
  {
    id: 'testadd-palindrome-capitalize',
    kind: 'test-add',
    description:
      'The test file test/string-utils.test.ts currently contains only a failing placeholder. Replace it with a real node:test suite that covers `isPalindrome` and `capitalizeWords` from src/string-utils.ts, including mixed-case and punctuation cases for `isPalindrome`. `npm test` must pass. Do not modify anything under src/.',
    mutations: [
      { file: 'test/string-utils.test.ts', find: '', replace: TODO_TEST_PLACEHOLDER, wholeFile: true },
    ],
    finalCheck: (read) => {
      const content = read('test/string-utils.test.ts');
      return content !== null && countOccurrences(content, 'test(') >= 2;
    },
  },
  {
    id: 'testadd-collections',
    kind: 'test-add',
    description:
      'The test file test/collections.test.ts currently contains only a failing placeholder. Replace it with a real node:test suite that covers `groupBy`, `uniqueBy`, `chunk`, and `pluck` from src/collections.ts. `npm test` must pass. Do not modify anything under src/.',
    mutations: [
      { file: 'test/collections.test.ts', find: '', replace: TODO_TEST_PLACEHOLDER, wholeFile: true },
    ],
    finalCheck: (read) => {
      const content = read('test/collections.test.ts');
      return content !== null && countOccurrences(content, 'test(') >= 4;
    },
  },

  // --- refactor (rename in src only; tests break until updated) ------------
  {
    id: 'refactor-rename-clamp',
    kind: 'refactor',
    description:
      'Rename the function `clamp` in src/math-utils.ts to `clampToRange`. Update every reference (source and tests) so the behavior is unchanged and `npm test` passes. The new name must be used everywhere afterwards.',
    mutations: [
      {
        file: 'src/math-utils.ts',
        find: 'export function clamp(value: number, min: number, max: number): number {',
        replace: 'export function clampToRange(value: number, min: number, max: number): number {',
      },
    ],
    finalCheck: (read) => {
      const src = read('src/math-utils.ts');
      const tests = read('test/math-utils.test.ts');
      return (
        src !== null &&
        tests !== null &&
        src.includes('clampToRange') &&
        tests.includes('clampToRange') &&
        !tests.includes('clamp(')
      );
    },
  },
  {
    id: 'refactor-rename-average',
    kind: 'refactor',
    description:
      'Rename the function `average` in src/math-utils.ts to `mean`. Update every reference (source and tests) so the behavior is unchanged and `npm test` passes. The new name must be used everywhere afterwards.',
    mutations: [
      {
        file: 'src/math-utils.ts',
        find: 'export function average(values: number[]): number {',
        replace: 'export function mean(values: number[]): number {',
      },
    ],
    finalCheck: (read) => {
      const src = read('src/math-utils.ts');
      const tests = read('test/math-utils.test.ts');
      return (
        src !== null &&
        tests !== null &&
        src.includes('export function mean(') &&
        tests.includes('mean(') &&
        !tests.includes('average(')
      );
    },
  },
  {
    id: 'refactor-rename-slugify',
    kind: 'refactor',
    description:
      'Rename the function `slugify` in src/string-utils.ts to `toSlug`. Update every reference (source and tests) so the behavior is unchanged and `npm test` passes. The new name must be used everywhere afterwards.',
    mutations: [
      {
        file: 'src/string-utils.ts',
        find: 'export function slugify(text: string): string {',
        replace: 'export function toSlug(text: string): string {',
      },
    ],
    finalCheck: (read) => {
      const src = read('src/string-utils.ts');
      const tests = read('test/string-utils.test.ts');
      return (
        src !== null &&
        tests !== null &&
        src.includes('export function toSlug(') &&
        tests.includes('toSlug(') &&
        !tests.includes('slugify(')
      );
    },
  },
  {
    id: 'refactor-rename-groupby',
    kind: 'refactor',
    description:
      'Rename the function `groupBy` in src/collections.ts to `indexBy`. Update every reference (source and tests) so the behavior is unchanged and `npm test` passes. The new name must be used everywhere afterwards.',
    mutations: [
      {
        file: 'src/collections.ts',
        find: 'export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {',
        replace: 'export function indexBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {',
      },
    ],
    finalCheck: (read) => {
      const src = read('src/collections.ts');
      const tests = read('test/collections.test.ts');
      return (
        src !== null &&
        tests !== null &&
        src.includes('export function indexBy(') &&
        tests.includes('indexBy(') &&
        !tests.includes('groupBy(')
      );
    },
  },
  {
    id: 'refactor-rename-pluck',
    kind: 'refactor',
    description:
      'Rename the function `pluck` in src/collections.ts to `pickField`. Update every reference (source and tests) so the behavior is unchanged and `npm test` passes. The new name must be used everywhere afterwards.',
    mutations: [
      {
        file: 'src/collections.ts',
        find: 'export function pluck<T, K extends keyof T>(items: T[], key: K): T[K][] {',
        replace: 'export function pickField<T, K extends keyof T>(items: T[], key: K): T[K][] {',
      },
    ],
    finalCheck: (read) => {
      const src = read('src/collections.ts');
      const tests = read('test/collections.test.ts');
      return (
        src !== null &&
        tests !== null &&
        src.includes('export function pickField(') &&
        tests.includes('pickField(') &&
        !tests.includes('pluck(')
      );
    },
  },
];

export function getTask(id: string): BenchTaskSpec | undefined {
  return BENCH_TASKS.find((t) => t.id === id);
}

export function selectTasks(filter?: string[]): BenchTaskSpec[] {
  if (!filter || filter.length === 0) return [...BENCH_TASKS];
  return BENCH_TASKS.filter((t) =>
    filter.some((f) => t.id === f || t.kind === f || t.id.startsWith(f)),
  );
}

// ---------------------------------------------------------------------------
// Fixture materialization
// ---------------------------------------------------------------------------

export function writeBaseFiles(destDir: string): void {
  for (const [relPath, content] of Object.entries(BASE_FILES)) {
    const abs = join(destDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

export function applyMutations(destDir: string, spec: BenchTaskSpec): void {
  for (const mutation of spec.mutations) {
    const abs = join(destDir, mutation.file);
    if (!existsSync(abs)) {
      throw new Error(`[${spec.id}] mutation target missing: ${mutation.file}`);
    }
    const original = readFileSync(abs, 'utf8');
    let updated: string;
    if (mutation.wholeFile) {
      updated = mutation.replace;
    } else {
      if (!original.includes(mutation.find)) {
        throw new Error(`[${spec.id}] mutation anchor not found in ${mutation.file}`);
      }
      updated = original.replace(mutation.find, mutation.replace);
    }
    writeFileSync(abs, updated, 'utf8');
  }
}

/** Write base files + the task's seeded mutation into a fresh directory. */
export function materializeFixture(spec: BenchTaskSpec, destDir: string): string {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  writeBaseFiles(destDir);
  applyMutations(destDir, spec);
  return destDir;
}

/** Reader closure for BenchTaskSpec.finalCheck. */
export function createFileReader(dir: string): (relPath: string) => string | null {
  return (relPath) => {
    const abs = join(dir, relPath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf8');
  };
}

// ---------------------------------------------------------------------------
// Ground-truth gate
// ---------------------------------------------------------------------------

/** Run `node --test test/` in a fixture directory. Exit code is the verdict. */
export function runTestSuite(dir: string, timeoutMs = 120_000): Promise<GateResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', 'test/*.test.ts'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        exitCode: null,
        output: `failed to spawn test runner: ${error.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = `${stdout}\n${stderr}`.trim();
      resolve({
        passed: code === 0,
        exitCode: code,
        output: output.slice(0, 20_000),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Sanity validation: base green, mutated red
// ---------------------------------------------------------------------------

/**
 * Verify a task spec is well-formed: the clean fixture passes the suite and
 * the mutated fixture fails it. Catches broken mutation anchors immediately.
 */
export async function sanityCheckTask(spec: BenchTaskSpec, scratchDir: string): Promise<SanityReport> {
  const cleanDir = join(scratchDir, `${spec.id}-clean`);
  const mutatedDir = join(scratchDir, `${spec.id}-mutated`);

  rmSync(cleanDir, { recursive: true, force: true });
  rmSync(mutatedDir, { recursive: true, force: true });
  mkdirSync(cleanDir, { recursive: true });
  writeBaseFiles(cleanDir);
  materializeFixture(spec, mutatedDir);

  const cleanGate = await runTestSuite(cleanDir);
  const mutatedGate = await runTestSuite(mutatedDir);

  const ok = cleanGate.passed && !mutatedGate.passed;
  const detail = ok
    ? 'clean passes, mutated fails'
    : `clean=${cleanGate.passed ? 'PASS' : 'FAIL'} mutated=${mutatedGate.passed ? 'PASS' : 'FAIL'}\n${
        !cleanGate.passed ? `--- clean output ---\n${cleanGate.output.slice(0, 2000)}\n` : ''
      }${mutatedGate.passed ? `--- mutated output ---\n${mutatedGate.output.slice(0, 2000)}` : ''}`;

  return {
    taskId: spec.id,
    cleanPassed: cleanGate.passed,
    mutatedFailed: !mutatedGate.passed,
    ok,
    detail,
  };
}
