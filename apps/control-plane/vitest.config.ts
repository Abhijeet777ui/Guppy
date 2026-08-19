import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The e2e tests spawn real subprocesses (npm test, git worktrees) on temp
    // fixtures; under parallel-file load the default 5s timeout is too tight
    // and these tests flake with "Test timed out in 5000ms".
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Worktrees materialize fixture copies (which include *.test.ts files)
    // under `.guppy/`; a leftover worktree must never be discovered as a
    // duplicate test. Exclude `.guppy/` and any worktrees dir from discovery.
    exclude: [...defaultExclude, '**/.guppy/**', '**/worktrees/**'],
  },
});
