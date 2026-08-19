# Plan: Cross-Repo Memory + Skill-Impact Bench (follow-ups to Slice 5)

> **Status: IMPLEMENTED (2026-08-19).** Both features shipped: the layered
> memory store (fixes mirror to `~/.guppy/memory`, reads merge, primary wins)
> and the `guppy-core-skill` bench config + `guppy-bench skill-demo`. Verified:
> 270 tests green across 14 suites. One real bug found and fixed along the way:
> the context engine's `extractKeywords` didn't strip backticks, so a task
> mentioning `` `clamp` `` never matched a skill about `clamp` — skills were
> silently dropped from context. The skill-demo exposed it; the keyword split
> now includes the backtick.

Two features, both extending the "distributed" story from Slice 5:

1. **Cross-repo memory** — a `fix` distilled in repo A is retrievable in repo B
   when the same failure occurs. The memory counterpart of `~/.guppy/skills`.
2. **Skill-impact bench** — a hermetic A/B that proves (or disproves) skills
   measurably change agent behavior, plus a deterministic no-LLM demo.

---

## Feature 1 — Cross-repo memory (layered memory store)

### Problem

Memory roots at `<repo>/.guppy/memory` (STATUS §5.7). Distilled `fix` memories
("last time this test failed, the fix was X") never leave the repo, so a
second repo hitting the same failure starts from zero.

### Design

Mirror the skills layering exactly: keep the per-repo store, add a per-user
**global store** at `~/.guppy/memory` (`$GUPPY_MEMORY_DIR`).

**`@guppy/memory`:**
- `defaultMemoryDir()` → `$GUPPY_MEMORY_DIR` ?? `~/.guppy/memory`.
- `MemoryStoreConfig` gains `secondaryRootDir?: string`. `createMemoryStore`
  builds a plain secondary `MemoryStore` when set (no recursion — the
  secondary never gets its own secondary).
- **Write rule:** `record()` always writes to the primary; **`fix` memories are
  additionally written to the secondary with the same id** (fixes are the
  cross-repo asset). Trajectory summaries stay local — they are noise across
  repos.
- **Read rule:** `retrieve()` scores/filters/decays each store separately
  (extract the scoring body into a private no-slice `scoreAll`), merges both
  candidates, **dedupes by id (primary wins)**, sorts, slices to the limit.
  `retrieveForFailure` inherits the merge (it calls `retrieve` with
  `type: 'fix'`).
- `count()` and `clear()` span both stores (tests + sleep-cycle re-ingest
  stay deterministic).

**`apps/control-plane` SessionManager:**
- `createSessionManager` passes `rootDir: <repo>/.guppy/memory` **and**
  `secondaryRootDir: defaultMemoryDir()`; `userMemoryDir?` config knob for
  hermetic tests (mirrors `userSkillsDir`).

**Non-goals (documented):** bench-runner memory stays isolated per-run under
`--out` — the bench measures the harness on equal footing, and a personal fix
store would contaminate the A/B. Sleep-cycle curation stays repo-local; the
global store accumulates until a curation story lands.

**Tests:** two stores sharing one global root — A distills a fix (present in
both files, same id), B retrieves it with an empty local store (the whole
cross-repo story, hermetically); primary-wins dedupe; trajectory memories
never reach the global store; `count`/`clear` span both; `defaultMemoryDir`
honors `GUPPY_MEMORY_DIR`.

---

## Feature 2 — Skill-impact bench (A/B + deterministic demo)

### Problem

Slice 5 ships skills into every run, but nothing measures whether they help.
The bench's claim-to-fame is "measured, not asserted" — skills should get the
same treatment.

### Design

**New config kind `guppy-core-skill`** in `bench-runner/runner.ts`:
- Identical closed loop to `guppy-core` (same runtime, verifier, retries) —
  the only difference: `selectContext` receives `loadSkills(skillsDir)` from
  `BenchOptions.skillsDir` (default: `defaultSkillsDir()` from
  `@guppy/skills`) instead of the fixture's `.guppy/skills` (fixtures carry
  none, so the A/B is literally "injected skills vs none").
- `--config guppy-core,guppy-core-skill` is the measured comparison; the
  report gets a dedicated A/B section.

**CLI:** `guppy-bench run --skills <dir>` (default = installed user skills);
`guppy benchmark` in the control-plane CLI gets the same `--skills` flag
(config validation flows through `ALL_CONFIGS` automatically).

**Report (`report.ts`):** when both `guppy-core` and `guppy-core-skill`
results exist, emit a **Skill impact A/B** section: per-task matrix
(baseline vs skill PASS/FAIL + delta), overall pass-rate delta (pp), token
delta, and the injected skill names + dir.

**Deterministic demo `guppy-bench skill-demo`** (new `skill-demo.ts`, same
shape as `loop-demo`): a scripted runtime on `bugfix-clamp` that only applies
the correct fix when `context.skills` contains the clamp-argument-order
skill (the skills.e2e trick, no LLM).
- Run A: no skills → naive edit → gate FAIL.
- Run B: skill injected → correct fix → gate PASS.
- Verdict = `runA gate red && runB gate green && runB had the skill in
  context` — the hermetic proof that a skill in context changes behavior and
  flips the gate, which is exactly what the real-model A/B measures at scale.

**Tests:** skill-demo end-to-end verdict (hermetic); report contains the A/B
section for a mixed result set. Existing config-list tests pass explicit
configs, so `ALL_CONFIGS` growth is safe.

---

## Verification

`pnpm -r run build && pnpm -r run test` — full suite green; new tests counted.
STATUS/ROADMAP updated.
