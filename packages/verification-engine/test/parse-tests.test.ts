import { describe, it, expect } from 'vitest';
import { parseTestResults } from '../src/index.js';

const SPEC_RED = `> test
> node --test test/*.test.ts

✔ groupBy groups items by key (2.7629ms)
✔ uniqueBy keeps the first item per key (0.2695ms)
✖ clamp keeps values inside the range (3.3814ms)
✔ sum adds all values (0.3697ms)
ℹ tests 4
ℹ pass 3
ℹ fail 1
ℹ duration_ms 237.2571

✖ failing tests:

test at test\\math-utils.test.ts:5:1
✖ clamp keeps values inside the range (3.3814ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  10 !== 5

      at TestContext.<anonymous> (file:///…/test/math-utils.test.ts:6:10)
`;

describe('parseTestResults', () => {
  it('parses spec-reporter pass and fail lines with real names', () => {
    const results = parseTestResults(SPEC_RED);
    const names = results.map((r) => r.name);
    expect(names).toEqual([
      'groupBy groups items by key',
      'uniqueBy keeps the first item per key',
      'clamp keeps values inside the range',
      'sum adds all values',
    ]);
  });

  it('deduplicates the failing-tests summary (name appears once, marked failed)', () => {
    const clamp = parseTestResults(SPEC_RED).filter((r) => r.name.includes('clamp'));
    expect(clamp).toHaveLength(1);
    expect(clamp[0]!.status).toBe('failed');
  });

  it('extracts the assertion message as the failure output', () => {
    const clamp = parseTestResults(SPEC_RED).find((r) => r.name.includes('clamp'));
    expect(clamp?.output).toContain('AssertionError');
    expect(clamp?.output).toContain('10 !== 5');
  });

  it('falls back to TAP output', () => {
    const tap = 'ok 1 - adds numbers\nnot ok 2 - divides by zero\nok 3 - trims strings\n';
    const results = parseTestResults(tap);
    expect(results.map((r) => r.status)).toEqual(['passed', 'failed', 'passed']);
    expect(results[1]!.name).toBe('divides by zero');
  });

  it('returns an empty list for unrecognized output', () => {
    expect(parseTestResults('some unrelated command output\n')).toEqual([]);
  });
});
