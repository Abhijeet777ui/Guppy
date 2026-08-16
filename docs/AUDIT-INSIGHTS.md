# Guppy — Audit Insights (2026-08-16)

> Written after a verification pass over the guppy workspace: every claim was
> re-checked against the current tree, not memory. This file is the evidence
> trail for the audit — what was true, what was wrong, and what changed.

## 1. Method

Instead of trusting `docs/STATUS.md`, I re-ran the build and test suite and
decoded the recorded bench artifacts:

- `pnpm -r run build` — green across all 11 workspace projects.
- `pnpm -r run test` — green, **109 tests across 8 suites** (see §3).
- Decoded `apps/bench-runner/.guppy/bench/**/results.json` and the msgpack
  event streams (`@msgpack/msgpack` `decodeMulti`) to check the real-model
  claims against the recorded events.

## 2. What was actually true

| Claim | Verdict |
|---|---|
| nemotron-3-super-120b free: **6/6 fixtures PASS, 1 attempt each, 214,773 tokens, 45 tool calls** | OK — `smoke-or/results.json` sums to exactly 214,773 tokens / 45 tool calls |
| guppy-core beats guppy-prime on `bugfix-clamp` | OK — `h2h-core` (1 attempt, PASS) vs `h2h-prime` (2 attempts, 59,034 tokens, FAIL) |
| Build green, tests all green | Half-true — the 8 suites passed, but the **root command** failed (§3.1) |

## 3. Grounding errors found (and fixed)

### 3.1 Root `pnpm test` was broken
`@guppy/contracts`, `@guppy/event-store`, and `@guppy/memory` ran
`vitest run` with zero test files, which exits 1 — so `pnpm -r run test`
(and root `pnpm test`) died on the first package. The "all green" claim was
only true if you skipped those three.
**Fix:** their test scripts now run `vitest run --passWithNoTests`.

### 3.2 Fixture count was wrong everywhere
Docs said **18 fixtures (10 bugfix / 5 testadd / 3 refactor)**. The actual
catalog in `fixtures.ts` is **20 (10 bugfix / 5 testadd / 5 refactor)** — the
two `refactor-rename-average` and `refactor-rename-pluck` tasks had been added
after the docs were written.
**Fix:** corrected in STATUS, CAPABILITIES, LAUNCH_CHECKLIST, and the plan.

### 3.3 An unrecorded real run
A **Gemini 2.5 Flash full-suite run scored 4/20** and was sitting in
`apps/bench-runner/.guppy/bench/gem-full/` — but the docs still claimed
"the full suite is still pending." **Fix:** recorded it (with the caveat below).

### 3.4 The silent 0-token failure bug (the important one)
All **16** of the Gemini run's misses recorded **0 tokens, 0 tool calls, and
no `ModelCalled` event**. That signature is diagnostic: it means the model
client **threw before any successful completion** (429 after retries, network,
or 4xx) — not that the agent tried and failed.

The bug: `CoreAgentRuntime.run()` caught the client error, marked the
trajectory `failure` with 0 tokens, and returned `ok(...)`. The bench runner
then ran the verification gate on top and recorded **the gate's red output**
as the failure cause — so `results.json` said "the tests failed" when the real
cause was "the model was never reached." This is the same silent-failure class
the docs claimed was fixed for prime (bug #3), still present in the core path.

**Fix:**
- `contracts`: added `Trajectory.error` and `TrajectoryCompletedEvent.error`.
- `core/runtime.ts`: records the client error on both.
- `bench-runner/runner.ts`: a 0-token failure trajectory that carries an error
  now **breaks loudly** as an infrastructure error, instead of being masked by
  the gate.
- Regression test: `apps/bench-runner/test/core-model-error.test.ts`.

### 3.5 Stale plan assumptions
`plans/guppy-consolidated-plan.md` still said "prime-agent owns the LLM loop"
and "Stage-0 gate blocked on environment." Reality: Guppy now owns the loop via
`@guppy/core` (zero pi/prime deps), and the gate was measured on free-tier
models. **Fix:** ADR-001/002 marked superseded, ADR-012 added, diagram updated.

## 4. The debugging insight (worth reusing)

> **A trajectory with outcome `failure`, 0 tokens, 0 tool calls, and no
> `ModelCalled` event means the runtime never got a model response** — it is an
> infrastructure error, not an agent outcome. Any harness that reports such
> trajectories as "task failed" without distinguishing them is silently
> misattributing API/network failures to the model.

The general lesson: **distinguish "the agent failed" from "the agent never
ran."** Record the error where the trajectory is recorded, and let the report
carry the true cause — never let a downstream gate overwrite it.

## 5. Meta-insights

1. **Results existed but weren't surfaced.** `results.json`/`report.md` were
   committed to disk but the docs lagged them, so the project's own evidence
   contradicted its README. Recording an artifact ≠ recording the *result*.
2. **Doc drift is a correctness bug, not a style issue.** "18 fixtures" and
   "prime owns the loop" were each provably false with one `grep`/file read.
   The launch checklist should treat doc claims as testable assertions.
3. **Free-tier validation is noisy.** Rate limits (429) are indistinguishable
   from model failure unless the harness records the HTTP error — which is why
   §3.4 was the highest-value fix of the audit.

## 6. Artifacts

- Results: originally under `guppy/.guppy/bench/` and `guppy/apps/bench-runner/.guppy/bench/`;
  now committed (results.json + report.md) under `guppy/docs/bench-results/<run>/` so the evidence
  survives in version control while the runtime `.guppy/` state is gitignored.
- Docs reconciled: `guppy/docs/{STATUS,CAPABILITIES,LAUNCH_CHECKLIST}.md`,
  `plans/guppy-consolidated-plan.md`
