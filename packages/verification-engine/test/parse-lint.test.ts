import { describe, it, expect } from 'vitest';
import { parseLintErrors } from '../src/index.js';

// Captured from a real `eslint@9.39.5` run (flat config, no-console + no-var).
const REAL_ESLINT_9_OUTPUT = `C:\\Users\\dev\\tmp\\repo\\src\\math.ts
  2:3  error  Unexpected console statement              no-console
  3:3  error  Unexpected var, use let or const instead  no-var

\u2716 2 problems (2 errors, 0 warnings)
  1 error and 0 warnings potentially fixable with the --fix option.
`;

describe('parseLintErrors', () => {
  it('parses real eslint 9 stylish output', () => {
    const errors = parseLintErrors(REAL_ESLINT_9_OUTPUT);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      file: 'C:\\Users\\dev\\tmp\\repo\\src\\math.ts',
      line: 2,
      column: 3,
      message: 'Unexpected console statement',
      rule: 'no-console',
    });
    expect(errors[1]).toMatchObject({
      line: 3,
      message: 'Unexpected var, use let or const instead',
      rule: 'no-var',
    });
  });

  it('handles multiple files with headers', () => {
    const out = `src/a.ts\n  1:1  error  msg one  rule-a\n\nsrc/b.ts\n  4:2  warning  msg two  rule-b\n`;
    const errors = parseLintErrors(out);
    expect(errors).toEqual([
      { file: 'src/a.ts', line: 1, column: 1, message: 'msg one', rule: 'rule-a' },
      { file: 'src/b.ts', line: 4, column: 2, message: 'msg two', rule: 'rule-b' },
    ]);
  });

  it('accepts the compact path:line:col form as a fallback', () => {
    const out = `src/a.ts:5:7  error  compact msg  some-rule\n`;
    expect(parseLintErrors(out)).toEqual([
      { file: 'src/a.ts', line: 5, column: 7, message: 'compact msg', rule: 'some-rule' },
    ]);
  });

  it('returns [] for clean or unrelated output', () => {
    expect(parseLintErrors('')).toEqual([]);
    expect(parseLintErrors('Everything looks good!\n')).toEqual([]);
  });
});
