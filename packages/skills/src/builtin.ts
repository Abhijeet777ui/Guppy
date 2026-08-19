/**
 * Built-in skill registry — a small, genuinely useful starter set bundled
 * with guppy so `guppy skill install <name>` works offline and hermetically.
 *
 * Entries point at `builtin` sources: the markdown bodies live in this module
 * as strings (no dist file-copy concerns), and the installer renders the
 * canonical front-matter + body when writing the skill to disk.
 */

import type { SkillRegistry } from './registry.js';

export interface BuiltinSkillDef {
  name: string;
  description: string;
  tags: string[];
  /** The prompt body only — front-matter is rendered by the installer. */
  body: string;
}

export const BUILTIN_SKILLS: BuiltinSkillDef[] = [
  {
    name: 'code-review',
    description: 'Self-review checklist before declaring a task done',
    tags: ['review', 'quality', 'done'],
    body: `Before declaring a task done, review your own diff like a critical reviewer:

- Re-read every changed file; remove debug prints, dead code, and unused imports.
- Check error paths: does every failure surface a useful message instead of a silent catch?
- Confirm the change is the smallest one that satisfies the task — no scope creep.
- Let the harness verification gate run; never claim success without a green gate.`,
  },
  {
    name: 'write-tests',
    description: 'Add tests that match the repo\u2019s existing framework and cover the new behavior',
    tags: ['test', 'testing', 'coverage'],
    body: `When the task involves tests, match the repo's existing framework and style:

- Find an existing test file next to the code you changed and mirror its imports and assertions.
- Cover the new behavior: the happy path plus at least one edge case or failure path.
- Run the repo's test command from the root and iterate until green before editing anything else.`,
  },
  {
    name: 'commit-hygiene',
    description: 'Keep the merge-back diff small, focused, and reviewable',
    tags: ['git', 'commit', 'merge'],
    body: `Guppy merges your changes back with a single commit per task. Keep the diff reviewable:

- Do not touch files unrelated to the task (no formatting-only edits, no stray deletions).
- After editing, run git status and git diff to confirm only intended files changed.
- Prefer several small focused edits over one sweeping rewrite.`,
  },
  {
    name: 'refactor-rename',
    description: 'Rename symbols safely across the whole repo',
    tags: ['refactor', 'rename'],
    body: `Renaming a symbol is a cross-file change. Do it in order:

1. Find every reference with the search tool before editing anything.
2. Update the definition and all references in the same pass.
3. Re-run the typecheck and the test suite; a rename is only done when both are green.`,
  },
];

/** The builtin registry manifest: every entry is a `builtin`-sourced skill. */
export const BUILTIN_REGISTRY: SkillRegistry = {
  name: 'guppy-builtin',
  skills: BUILTIN_SKILLS.map((s) => ({
    name: s.name,
    description: s.description,
    tags: s.tags,
    version: 1,
    source: 'builtin',
  })),
};

/** Look up a builtin skill's prompt body by name (sluggish match). */
export function builtinSkillBody(name: string): string | null {
  const key = name.trim().toLowerCase();
  return (
    BUILTIN_SKILLS.find((s) => s.name.toLowerCase() === key)?.body ?? null
  );
}
