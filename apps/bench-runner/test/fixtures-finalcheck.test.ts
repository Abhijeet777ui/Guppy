import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileReader, getTask, materializeFixture } from '../src/fixtures.js';

/**
 * Simulate a correct rename: the fixture's mutation already renamed the symbol
 * in `src/`, so the agent's remaining work is to rename the references in the
 * test file. The acceptance check must then pass. Regression guard for the
 * bug where a generic function's finalCheck matched the non-generic signature
 * (`export function indexBy(`) and therefore could never be satisfied.
 */
function simulateRename(taskId: string, testFile: string, from: string, to: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-finalcheck-'));
  try {
    materializeFixture(getTask(taskId)!, dir);
    const testPath = join(dir, testFile);
    writeFileSync(testPath, readFileSync(testPath, 'utf8').split(from).join(to), 'utf8');
    return getTask(taskId)!.finalCheck!(createFileReader(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('refactor-rename finalCheck', () => {
  it('accepts a correctly-renamed generic function (groupBy → indexBy)', () => {
    expect(simulateRename('refactor-rename-groupby', 'test/collections.test.ts', 'groupBy(', 'indexBy(')).toBe(true);
  });

  it('accepts a correctly-renamed generic function (pluck → pickField)', () => {
    expect(simulateRename('refactor-rename-pluck', 'test/collections.test.ts', 'pluck(', 'pickField(')).toBe(true);
  });
});
