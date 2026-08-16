import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, applyHunks } from '../src/patch.js';

describe('parseUnifiedDiff', () => {
  it('parses a multi-file patch with create, modify, and delete', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' context',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+hello',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-bye',
    ].join('\n');

    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(3);

    expect(files[0]!.path).toBe('src/a.ts');
    expect(files[0]!.isNew).toBe(false);
    expect(files[0]!.isDelete).toBe(false);
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'remove', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'context', text: 'context' },
    ]);

    expect(files[1]!.path).toBe('new.ts');
    expect(files[1]!.isNew).toBe(true);
    expect(files[2]!.path).toBe('gone.ts');
    expect(files[2]!.isDelete).toBe(true);
  });
});

describe('applyHunks', () => {
  it('applies a simple modify hunk preserving the trailing newline', () => {
    const original = 'one\ntwo\nthree\n';
    const files = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n');
    expect(applyHunks(original, files[0]!.hunks)).toBe('one\nTWO\nthree\n');
  });

  it('creates a new file from /dev/null', () => {
    const files = parseUnifiedDiff('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(applyHunks('', files[0]!.hunks)).toBe('a\nb');
  });

  it('applies multiple hunks bottom-up', () => {
    const original = 'a\nb\nc\nd\ne\nf\n';
    const patch = [
      '--- a/f',
      '+++ b/f',
      '@@ -2,2 +2,2 @@',
      ' b',
      '-c',
      '+C',
      '@@ -5,2 +5,2 @@',
      ' e',
      '-f',
      '+F',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    expect(applyHunks(original, files[0]!.hunks)).toBe('a\nb\nC\nd\ne\nF\n');
  });

  it('tolerates drifted line numbers via fuzzy context matching', () => {
    // The hunk claims line 1 but the content actually lives at line 4.
    const original = 'skip\nskip\nskip\ntarget\nkeep\n';
    const files = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-target\n+TARGET\n');
    expect(applyHunks(original, files[0]!.hunks)).toBe('skip\nskip\nskip\nTARGET\nkeep\n');
  });

  it('throws when the context cannot be found', () => {
    const original = 'nothing\nmatches\n';
    const files = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -10,1 +10,1 @@\n-ghost\n+nope\n');
    expect(() => applyHunks(original, files[0]!.hunks)).toThrow(/failed to match context/);
  });
});
