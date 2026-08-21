# Contributing to Guppy

Thanks for swimming in. The short version of this file: **every change lands with a gate, every claim lands with evidence, and the bench A/B is how we argue.** If that culture sounds good to you, read on — it's short.

## Setup

Requirements: Node ≥ 20, pnpm 11, Docker Desktop (only for the container sandbox — the test suite runs without it).

```bash
git clone https://github.com/Abhijeet777ui/Guppy.git
cd Guppy
pnpm install
pnpm build
pnpm test        # full suite — 323 tests across 13 packages, offline, no keys
```

You don't need an API key to develop: the deterministic-first pillar means the entire suite runs hermetically. Keys are only needed for real-model bench runs (see "The bench" below).

## The house rules

1. **The gate is the arbiter, not the model.** A change is "done" when the verification ladder passes — typecheck → lint → tests → property → integration → invariant gate. If you add a feature, add the gate that proves it. If you fix a bug, add the regression test that pins it (the repo's bug log in `docs/STATUS.md` is written this way).
2. **Hermetic fixtures, ground truth = exit code.** Bench fixtures are zero-dependency TS repos run with `node --test`. A fixture is *clean* when a clean repo goes green and the same repo with a seeded bug goes red — that's what `guppy-bench sanity` (21/21) checks.
3. **Evidence over vibes.** Claims go in docs with a pointer to the artifact: a commit, a test, a recorded run in `docs/live/`, or a `docs/bench-results/` report. A claim without a source doesn't land.
4. **Decisions get ADRs.** Substantive architecture decisions are one row in the ADR log in `plans/guppy-consolidated-plan.md` (there are 13). If your PR changes how the loop works, add the row.
5. **Missing tools are skips, not faults.** A repo without eslint never makes the agent look bad (ADR-011). Environment conditions must not poison the ladder.

## Working in the repo

- **Monorepo:** pnpm workspace. Packages in `packages/` (`core`, `contracts`, `event-store`, `workspace`, `verification-engine`, `context-engine`, `memory`, `skills`, `mcp`, `models`), apps in `apps/` (`control-plane` = the CLI/TUI, `bench-runner` = `guppy-bench`, `sleep-cycle`).
- **Per-package checks:** `pnpm --filter @guppy/core test` (or `build`) from the repo root.
- **The bench:** `node apps/bench-runner/dist/cli.js sanity` after a build. Real-model A/Bs go in `docs/bench-results/` with the merged JSON + report. (Note: on a fresh install, the `guppy-bench` / `sleep-cycle` bin shims don't exist — pnpm creates bins at install time, before `dist/` exists, and doesn't retro-create them after `pnpm build`. Run the CLI via `node apps/bench-runner/dist/cli.js` directly, or re-run `pnpm install` after building.)
- **Dogfooding is encouraged:** Guppy is a harness — run it on its own bugs (`pnpm cli -- run "..."`).

## Good first contributions

The roadmap (`docs/ULTIMATE-ROADMAP.md`) is a list of gated phases — the natural place to find work. Phase 0 (the proven baseline) is done; Phases 1–8 are open and each has a *measured* exit criterion, so a phase is a project you can own.

Smaller first-PR candidates (all gated, all testable):

- **Docs hygiene:** stale numbers in README/docs (the audit trail is `docs/AUDIT-INSIGHTS.md`).
- **Fixture breadth:** a new hermetic fixture for the bench (bugfix / testadd / refactor) — sanity-validated and measured.
- **Test hardening:** the suite is the product; more edge cases in verification-engine, context-engine, or the TUI logic are always welcome.
- **Real-world hardening:** run `guppy run` on your own repo, and open a PR with the finding + regression test. This is how the biggest bugs in this codebase were found.

Before opening a PR: `pnpm build` and `pnpm test` green, a fixture/gate if behavior changed, and a one-line "evidence" note in the PR description (test name, fixture, or recorded run).

## Code of conduct

Be specific, be kind, and prefer a green test over a strong opinion. Disagreements are settled by the bench, not by volume.
