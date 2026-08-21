# Development Rules

## Conversational Style

- Keep answers short and concise; technical prose only, be direct.
- No emojis in commits, issues, PR comments, or code (the README's fish branding is marketing; the repo itself stays plain).
- When the user asks a question, answer it first before editing or running commands.
- When responding to feedback or an analysis, say explicitly whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not already fully inspected, and when asked to investigate or audit. Do not rely only on search snippets for broad changes.
- No `any` types unless absolutely necessary.
- **No inline imports** — no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic type imports. Standard top-level imports only.
- Check `node_modules` for external API type definitions instead of guessing (the `pi-ai` / `pi-tui` packages are type-checked this way).
- Never remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user explicitly asks for it.
- Never edit generated artifacts: `dist/` is gitignored (built via `tsc`), and `apps/bench-runner/src/fixtures.ts` is the only place fixtures are defined — never hand-edit a materialized fixture under `.guppy/`.

## Commands

- This is a **pnpm** monorepo (npm is not used here). Node >= 20, pnpm 11.
- After code changes (not docs): run the package's `build` (tsc) and `lint` (biome), then the relevant tests. From the repo root:
  - `pnpm -r run build` — full build (13 packages)
  - `pnpm -r run lint` — biome across the workspace
  - `pnpm test` — full suite (323 tests across 13 packages; offline, no API keys)
  - `pnpm --filter @guppy/verification-engine test` — one package
- For a single test file, from the package directory:
  `npx vitest run test/config.test.ts`
- **If you create or modify a test file, run it and iterate until it passes.**
- The bench gate: after a build, `node apps/bench-runner/dist/cli.js sanity` — **21/21 fixtures must stay clean** (clean repo green, mutated red). Any new or edited fixture must pass this.
- The container e2e (in the control-plane suite, `vitest run --testTimeout=120000`) executes for real only when Docker Desktop is running; otherwise it self-skips. Rebuild the sandbox image with `pnpm docker:build` after touching `docker/executor`.
- Never run real provider APIs or paid tokens in tests. The suite is hermetic by design (deterministic-first pillar): scripted runtimes and the `loop-demo` pattern are the tools for deterministic proofs.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Git

Multiple agents or sessions may work in this repo at once, each touching different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work.

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path>`); **never** `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Commit style matches the repo history: short imperative subject, no conventional-commit prefix (e.g. `Fix resumed container runs losing the node_modules mount`, not `fix(workspace): ...`).
- Never run (destroys other sessions' work or bypasses checks): `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.
- If rebase conflicts occur, resolve only in files you modified. If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.
- Branch model: `main` is the stable verified harness; forward work lives on `feature/nexus` and merges only once proven.

## The evidence culture (this is the product)

- **Every claim lands with evidence.** A behavior change ships with the test, fixture, or recorded run that proves it; a docs claim ships with a pointer to the artifact (commit, test name, `docs/live/` recording, or `docs/bench-results/` report).
- **The gate is the arbiter.** "Done" means the verification ladder passed, never the model's self-report. Missing verification tools are skips-with-note, never agent faults (ADR-011).
- **Decisions get ADR rows.** Substantive architecture decisions are recorded in the ADR log. Note: the log currently lives at the workspace root in `plans/guppy-consolidated-plan.md` (outside this clone); when that file is not present, record the decision as a dated bullet in `docs/STATUS.md` instead. Keep `docs/STATUS.md` updated for anything user-visible (bullets are dated and cite evidence).
- **New bench fixtures** go in `apps/bench-runner/src/fixtures.ts` (bugfix / testadd / refactor), are hermetic (zero-dependency TS, `node --test`, ground truth = exit code), and must pass `guppy-bench sanity` before landing.

## Conventions

- Docs in this repo are CRLF on Windows. Keep the line endings of the file you touch; when creating a new doc, match the sibling files.
- `docs/` is the evidence home: `docs/live/` for recorded real runs, `docs/bench-results/` for bench artifacts, `docs/STATUS.md` for the verified status and bug log, `docs/ULTIMATE-ROADMAP.md` for the destination and per-phase exit gates.
- Runtime state (`.guppy/` dirs, event stores, checkpoints, memory) is regenerable and gitignored — never commit it.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
