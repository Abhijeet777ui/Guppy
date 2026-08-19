# Guppy — Project Status Report

**Date:** August 17, 2026 (freshest section §0 below; §1+ is the August 16 report, still accurate for engine internals)
**Scope:** All `packages/*` and `apps/*` in the guppy workspace, plus the `prime-agent/` integration used as an A/B baseline.

---

## 0. August 19 session — Slice 5 + cross-repo memory + skill bench — READ THIS FIRST (restart point)

**Slice 5 shipped:** `guppy skill install <name|url|path>` / `guppy skill remove <name>` / `guppy skill list` (user + repo origins) via a new **`@guppy/skills`** package. Skills install into the per-user `~/.guppy/skills` (or `$GUPPY_SKILLS_DIR`) from a registry (`--registry` accepts a URL, file path, or inline JSON; default is the bundled `guppy-builtin` registry: code-review, write-tests, commit-hygiene, refactor-rename), a direct `https://` URL to a `.md` skill file, or a local path. Installed files carry `source:` / `installed-at:` provenance front-matter; duplicate installs refuse without `--force`; `skill install` with no args lists the registry with installed marks. **SessionManager now loads user-level skills merged with repo skills** (repo wins name collisions), so an installed skill reaches the model's context in every repo — the cross-repo half of §5.7 for skills. Verification: build green; **262 tests** across 13 suites (`@guppy/skills` adds 13; the only full-suite misses were two pre-existing timing flakes under parallel load — `mcp` bridge and control-plane lint e2e — both pass in isolation). Live CLI smoke: install/list/remove round-trip verified.

**Follow-ups (same session):** (1) **Cross-repo memory** — `@guppy/memory` now supports a layered per-user global store at `~/.guppy/memory` (`$GUPPY_MEMORY_DIR`): `fix` memories distill into both the repo store and the global store (same id), reads merge both with the primary winning dedupes, trajectory summaries stay repo-local, `count`/`clear` span both. SessionManager wires it by default, so a fix distilled in repo A is retrieved in repo B — the memory counterpart of `~/.guppy/skills` (STATUS §5.7 closed for memory too). (2) **Skill-impact bench** — new `guppy-core-skill` bench config: identical closed loop to `guppy-core` but with skills injected from `--skills <dir>` (default: the installed per-user skills dir), plus a **Skill impact A/B** report section (per-task matrix, pass-rate pp + token deltas) when both configs run, and a deterministic **`guppy-bench skill-demo`** (no LLM): the same fixture + scripted runtime twice — no skill → naive edit → gate red; clamp-fix skill in context → correct fix → gate green. **Bug found + fixed:** context-engine `extractKeywords` didn't strip backticks, so a task mentioning `` `clamp` `` produced the keyword "`clamp`" and never matched a skill about `clamp` — skills were silently dropped from context; the split now includes the backtick (the skill-demo exposed it). Verification: build green; **271 tests** across 14 suites (memory 18, bench-runner 27 incl. skill-demo + report A/B + the guppy-core-skill routing regression test, control-plane 80, all others unchanged); full-suite run had zero flakes this time. **Real-model skill A/B (2026-08-19):** 6/6 PASS (3/3 each, 1 attempt) on nemotron-3-super-120b free — the first run exposed a routing bug (#15: `guppy-core-skill` hit the prime runtime; fixed + regression-pinned), and the corrected run measured **+0pp pass rate, +9,894 tokens** for the generic builtin skills (artifacts in `docs/bench-results/skill-ab-nemotron/`; honest finding: generic starter skills cost tokens but don't change outcomes the model already solves; task-specific skills flip gates, proven by skill-demo).

**High-level UI verification (2026-08-19):** headless screen-dump review of the real TUI (alt-screen, actual rendered grids via `ansi-screen`): boot/build mode, success ✓ footer + markdown reply, gate-failure ✗ footer, cancelled ✕ footer, `/verify 2` (context bar updates), `/theme light`, `/model qwen` autocomplete dropdown (provider/model/ctx/reasoning + scroll info), plan mode indicator + plan gate + `/build` execution, Ctrl+C interrupt → clean cancelled, `/edit` plan revision, `/exit`/EOF mid-turn shutdown, and the session goodbye dump. Full UI suites green: tui-logic 24, ansi-screen 8, live-stream 6, pickers 5, chat (TUI + REPL) 13, screen-demo 1. Remaining launch-gate UI item is the human visual sign-off on a real terminal (M3).

## 0.1 August 17 session — READ THIS FIRST (restart point)

**One-paragraph state:** The engine is built and green. M1–M3 of the UX track are done — the chat TUI, setup wizard, and launch pickers work; Ctrl+C interrupts a turn; themes + exit dump are in; and two real bugs found in live testing today are fixed (the worktree copy crash and the model-stream stall hang). **249 tests pass** across 12 suites (`pnpm -r run build` + `pnpm -r run test` green; `contracts` passes via `--passWithNoTests`). Slice 2 (MCP) shipped and the servers are sandboxed (scrubbed env, workspace cwd, guaranteed tree-kill on session end, proven by a hostile-server test). Slice 4 (plan/build) shipped: a read-only plan phase with a plan gate + `/build` approval. Everything below is **uncommitted on disk** — nothing has been committed today.

### What shipped today

| Item | Where | Status |
|---|---|---|
| **M1 — chat TUI** (faithful screen: context bar, markdown replies, one activity line, dim footer, headless test harness) | `apps/control-plane/src/tui.ts`, `tui-logic.ts` | ✅ built + tested |
| **M2 — onboarding & pickers** (setup wizard + launch picker; model lists fetched **live** from the provider's `/models` endpoint, free-tier sorted first, catalog fallback; picked model works even when not in the catalog) | `apps/control-plane/src/pickers.ts`, `packages/models/src/live-models.ts` | ✅ built + tested (used live by the user) |
| **`--` CLI fix** (`pnpm cli -- chat` ≡ `pnpm cli chat`) | `cli.ts` | ✅ |
| **M3 — interrupt/theme/exit dump** (`AbortController` threaded through core client + runtime; `'cancelled'` outcome; `/theme light|dark`; session dump on exit) | `packages/core/*`, `packages/contracts`, `tui.ts` | ✅ built + tested |
| **Bug fix — worktree copy crash** (`ERR_FS_CP_EINVAL: Cannot copy … to a subdirectory of self` when chatting from a non-git folder like `apps/control-plane`; default `worktreeBase` moved from `<cwd>/.guppy/worktrees` to `~/.guppy/worktrees` — also gets worktrees out of the OneDrive sync path) | `packages/workspace/src/index.ts` | ✅ fixed + e2e-proven on a non-git repo |
| **Bug fix — model stream stall hang** (the 120s timeout only covered time-to-first-byte; a stream that sent headers then went silent hung forever — the user's 5-min frozen spinner. Added a 60s idle timeout per stream chunk + for the non-streaming body read; a stall now fails visibly in ≤60s) | `packages/core/src/openai-client.ts` | ✅ fixed + 2 new tests |

### Verification numbers (current)

`pnpm -r run build` green (13 packages). `pnpm -r run test`: **249 tests** — core 33, models 43, control-plane 80, mcp 13, event-store 11, memory 13, workspace 7, verification-engine 9, context-engine 8, sleep-cycle 6, agent-runtime 3, bench-runner 23, contracts via `--passWithNoTests`.

### What's left / next

1. **Visual sign-off** of the chat screen (`pnpm cli -- chat --local`) — user eyeballs it, says "looks good".
2. **Plan/build modes** ✅ — Slice 4 shipped the real plan phase (the indicator stub is now live behavior): `/plan` makes every message a read-only planning turn through a dedicated read-only core runtime (write/run/patch tools withheld, MCP tools dropped), the plan renders with a `Plan ready — /build to execute · /edit to revise` gate footer, and `/build` approves it (emitting `PlanApproved`) and runs it through the full gated loop. `/edit [text]` revises the pending plan by hand (verbatim, no model call) before `/build`, recording a `PlanRevised` event with the model-plan line diff. `PlanProduced`/`PlanRevised`/`PlanApproved` are durable events. Works in both the TUI and the line REPL.
3. **Slice 2 — MCP external tools** ✅ — `@guppy/mcp` + `guppy mcp add/list/remove` shipped (13 tests; bridges servers over stdio via the official SDK). Server processes are sandboxed: env scrubbed of credentials, cwd pinned to the workspace, and a guaranteed tree-kill on session end (SDK `close()` only kills the direct child — `killProcessTree` gets the detached grandchildren, with a hostile-server test proving all three layers). Note: the SDK's zod graph hit OneDrive cloud-placeholder hangs on this machine — fixed by re-extracting the placeholder files from the npm tarball. The book's "MCP queued, not shipped" gap on Guppy's card is now closed.
4. **Launch gate** (from `LAUNCH_CHECKLIST`): a clean 20-fixture free-tier run — the earlier Gemini 4/20 was contaminated by the now-fixed silent-failure bug; Groq qwen3.6-27b hit 20/20 by rotating 3 keys.

### Restart commands

```bash
cd guppy
pnpm -r run build && pnpm -r run test   # full verification (~1–2 min)
pnpm cli -- chat --local                # chat TUI (from the guppy root)
pnpm cli -- setup                       # re-run wizard if needed
```

`pnpm cli` only resolves from the **guppy root**. From a subdirectory use `pnpm --filter @guppy/control-plane start chat --local`.

### Gotchas (learned the hard way today)

- **OneDrive eats new files** — `write_file` on new `apps/`/`packages/` paths failed or silently vanished all session; the workaround was writing via terminal heredocs (content identical). If a file seems missing, that's the quirk — rewrite it.
- **Free OpenRouter models can stall** under load (the user's `:free` router). Now bounded to 60s + visible error, but if a turn "does nothing", that's the endpoint — resend or switch to Groq `qwen3.6-27b` (`/provider groq` + `/model qwen` in chat).
- Worktrees live at `~/.guppy/worktrees` now (outside OneDrive) — old ones under `<repo>/.guppy/worktrees` can be deleted.
- A non-git repo (like `apps/control-plane`) uses the plain-copy path; the copy **excludes `node_modules`**, so gates like `tsc`/`vitest` get skipped in that worktree (works fine in git repos with installed deps).

### Side project — the book

We're incubating **the source book on harness engineering** — a classification axis + one-page "Harness Card" format + decision framework for Claude Code / Prime / Hermes / Antigravity / OpenClaw / Guppy, with this repo as the fully-dissected example. Blueprint: [`docs/HARNESS-BOOK.md`](HARNESS-BOOK.md) · in-depth working plan: [`docs/BOOK-MASTER-PLAN.md`](BOOK-MASTER-PLAN.md). Not on the product roadmap — the product is the book's lab, and every milestone donates a chapter section.

---

**Headline:** The learn → act → verify → remember loop is **working and proven against a real model**, and the product loop is now closed — a successful run **merges the agent's changes back into your repo**. Resilience (resume, retry), feel (streaming, chat), tools (search/apply_patch/git), skills (loader + `guppy skill add`), and the **Docker sandbox** (built + container-mode e2e) are shipped; what remains is proving the loop at scale on **free-tier / open-weight models** (no paid key required — the launch target is exactly a student/individual budget).

---

## 1. How this report was verified

Every claim below was checked against the current tree, not memory:

- **Build:** `pnpm -r run build` — green across all 11 workspace projects.
- **Tests:** `pnpm -r run test` (root `pnpm test`) — green end-to-end; 182 tests across 11 suites (only `contracts` passes via `--passWithNoTests`):

  | Suite | Tests | Covers |
  |---|---|---|
  | `@guppy/core` | 29 | OpenAI client (request shape, auth, errors, fenced-JSON + `<function/name>` text-tool-call fallbacks, assistant `tool_calls.type` normalization, streaming SSE, backoff, per-request timeout, sliding-window rate limiter, `extraBody` passthrough), full core tool loop E2E, rich tools (search/apply_patch/git) |
  | `@guppy/models` | 33 | pi-ai catalog facade (providers/models/search, core-compatible filter), catalog → `ModelConfig` mapping, thinking/reasoning passthrough (per-provider shapes, `--thinking`/`/thinking` level flag), per-user `~/.guppy/config.json` (load/save/mask/resolve + CLI-flag precedence) |
  | `@guppy/workspace` | 7 | unified-diff parser + fuzzy hunk applier, symlink path containment |
  | `@guppy/agent-runtime` | 3 | prime-agent spawn → JSONL framing → parse → events E2E; non-zero exit; missing binary |
  | `@guppy/verification-engine` | 9 | level commands, output parsers (incl. real-eslint stylish), escalation |
  | `@guppy/event-store` | 11 | append/replay roundtrip + enrichment, replay `fromIndex`/filter, durability across close/reopen, session auto-begin + finalization (unknown on switch, real outcome on `TrajectoryCompleted`), trajectory metrics, live subscribe + throwing-listener isolation, checkpoints, SQLite index queries + task deletion |
  | `@guppy/memory` | 13 | record/count/clear, persistence across instances, corrupt-line tolerance, tag/type/taskId/limit retrieval + recency decay, `retrieveForFailure`, `ingestTrajectory`, `extractFixes` (failure→change→pass, unresolved, typecheck, over-attribution) |
  | `@guppy/sleep-cycle` | 6 | failure clustering, fix extraction, memory re-ingest |
  | `@guppy/context-engine` | 8 | skills loader/producer/selection |
  | `@guppy/control-plane` | 40 | full standalone loop, resume, checkpoint, live-stream, chat (incl. mid-turn-exit), TUI logic (transcript buffer, model picker items, status line), worktree merge-back, skills E2E, verification levels 2/4/5 E2E, container-mode E2E (skipped without Docker or the locally-built executor image) |
  | `@guppy/bench-runner` | 23 | context-health/tokens-saved bridge, dry-run wiring, prime binary resolution, loud spawn failures + loud model-client error surfacing, dataset loaders + materialization, refactor-rename `finalCheck` regression (generic signatures) |

- **Real-model runs:**
  - `qwen2.5-coder:1.5b` via local Ollama (free, offline) — both runtimes, 2 fixtures (0/2 — too weak).
  - `nvidia/nemotron-3-super-120b-a12b:free` via OpenRouter (real API key) — **6/6 fixtures PASS in one attempt each** (bugfix-clamp/sum/average, testadd-math-utils/collections, refactor-rename-clamp; 214,773 tokens, 45 tool calls).
  - `llama-3.3-70b-versatile` via Groq free — `bugfix-clamp` PASS after the `<function/name>` text-tool-call parser fix; 100k TPD cap exhausted same day (a fixture run needs ~100k tokens).
  - `gemini-2.5-flash` via Google AI Studio free — 2/2 smoke (`bugfix-clamp` + `bugfix-sum`) PASS; a later **full 20-fixture run scored 4/20**, but 16 of those misses recorded 0 tokens / 0 tool calls because the model client threw and the error was silently masked as a gate failure — see §7 #13 (fixed).
  - `qwen/qwen3.6-27b` via Groq free (2026-08-16, three keys) — **20/20 fixtures PASS (100%)**. Each Groq free key caps at **200k tokens/day** (TPD), so the full pass needed three keys. Surfaced and fixed a real fixture bug: `refactor-rename-groupby`/`pluck` `finalCheck` matched the non-generic `export function X(` signature, but `indexBy<T>`/`pickField<T, K…>` are generic — the check could never pass; fixed + regression-tested. Evidence: `docs/bench-results/launch-qwen-groq/merged-results.json`.
  - **Live product recordings (2026-08-16)** — real `guppy run` (bugfix-clamp: gate red → agent fixes → gate green → merge-back, 39s, 12.6k tokens) and `guppy chat` (tool-backed Q&A, all gates green) on qwen3.6-27b; transcripts in `docs/live/`.

---

## 2. Architecture snapshot

```
packages/
  contracts/          377 lines   Event + trajectory type model (shared)
  event-store/        696 lines   msgpack persistence + optional SQLite index, replay, live subscribe
  workspace/          578 lines   WorkspaceManager: local + Docker, path containment
  verification-engine 453 lines   Levels 0–6, output parsers, escalation, availability guard
  context-engine/     558 lines   File/memory/skill selection, token budgeting, cache-aware packing
  memory/             300 lines   Trajectory distillation → fixes, scored retrieval
  agent-runtime/     1235 lines   AgentRuntime iface + PrimeDaemonRuntime + PiAgentRuntime (quarantined)
  core/               737 lines   Guppy-native model client + tool loop (the default brain)
  models/             342 lines   pi-ai catalog facade → ModelConfig + thinking passthrough (pi-ai confined here)

apps/
  control-plane/      685 lines   `guppy` CLI: run / chat / replay / trace / benchmark; SessionManager + live-stream
  bench-runner/      2322 lines   `guppy-bench` CLI: list / sanity / run / loop-demo / sleep-cycle
  sleep-cycle/        437 lines   Offline failure clustering + report + memory curation
```

pi/prime code is confined to `agent-runtime` (both adapters opt-in behind `--runtime prime|pi`) and `models` (the pi-ai *catalog*, used as a published MIT dependency and attributed in NOTICE). The default runtime — `guppy run --runtime core` — depends on neither, and `@guppy/core` itself remains pi/prime-free.

---

## 3. What works (verified)

### 3.1 The standalone core loop (`@guppy/core`)
- `ModelConfig` with provider → env-var key resolution (`openai`, `openrouter`, `nvidia`, `prime`, `anthropic`, `groq`, `google`, `deepseek`, `mistral`, `xai`, `cerebras`, `together`, `fireworks`) and an `extraBody` passthrough for provider-specific request fields (reasoning/thinking toggles).
- `OpenAIChatClient.complete()` over raw `fetch` to any `/chat/completions` endpoint: messages + tool definitions, native `tool_calls` parsing, **fenced-JSON tool-call fallback** (needed for qwen2.5-coder, which answers tool requests as JSON text), token usage, descriptive HTTP errors.
- `CoreAgentRuntime` implements `AgentRuntime`: builds a system prompt from selected context (files, test results, errors, memories, skills), loops model ↔ tools up to `maxTurns`, emits `TaskStarted / ModelCalled / AssistantMessage / ToolCalled / ToolReturned / FileChanged / TrajectoryCompleted`, accumulates token/tool metrics, maps completion to `success | partial | failure`. It also snapshots a full-context resume cursor per attempt and implements `resume(checkpoint)` — replaying the session log to reconstruct the exact model-visible conversation (the `AssistantMessage` + `ToolReturned.toolCallId` events make the log fully reconstructable) and continuing the loop from the last complete turn.
- Tools: `search` (ripgrep-backed with a substring fallback), `read_file`, `write_file`, `apply_patch` (diff-aware, emits one `FileChanged` per file), `list_files`, `run_command`, `git_status`, `git_diff` — all through `WorkspaceManager`, so path containment is enforced at one choke point.

**Proof:** E2E test drives a scripted mock LLM through `write_file → run_command → final answer`; a real run with nemotron 3 super 120b fixed `bugfix-clamp` in one attempt (see §6).

### 3.2 The outer loop (`control-plane` SessionManager)
- Pre-run **baseline gate** (level 1 = typecheck) — establishes what's already broken before the agent starts; skips cleanly when the tool isn't installed (fixed the `npx tsc` junk-package bug).
- **Gated retry loop:** context select → run → verify → on failure, feed test results + errors + retrieved memories into the next attempt.
- **Memory distillation:** on success, the trajectory is distilled into a `fix` memory persisted to `<repo>/.guppy/memory` and retrieved on later failures in the same repo.
- `resumeTask(checkpoint)` re-attaches a saved worktree and continues from the next attempt (see §5.1 — wired in local mode).

**Proof:** control-plane E2E — attempt 1 writes a wrong fix → real `npm test` gate fails → attempt 2 gets the failure in context → correct fix → gate passes → memory distilled.

### 3.3 Verification engine
- 7 levels: `0 syntax, 1 typecheck, 2 lint, 3 unit-tests, 4 property-tests, 5 integration-tests, 6 formal-verification`.
- Parsers for tsc output, eslint stylish output (validated against real eslint 9.39.5), vitest/spec output, and TAP — extract per-file/per-test structured errors.
- `levelAvailable()` guard, escalation to the next level, per-level timeouts, structured `VerificationResult`.
- Tool levels (tsc/eslint/dafny) resolve from the **source repo's** node_modules via `npm exec --prefix` and run against the worktree — worktrees carry no node_modules, so a bare `npx` there would silently skip or download.
- Levels 2/4/5 wired and gated end-to-end (see §8 phase 5); **level 6 (Dafny) is explicitly unsupported** — `-v 6` is rejected by the CLI with a clear message rather than silently never running a gate.

### 3.4 Context engine
- File selection: error-file **must-include**, task-keyword overlap scoring, failed-test file promotion, token estimation, budget packing with cache-awareness.
- Memory selection scored against the task + errors; skills loaded from `<repo>/.guppy/skills`, selected by task/tag relevance, and rendered into the system prompt's `=== SKILLS ===` section (see §5.6).

### 3.5 Memory
- `extractFixes(events)` — a fix is a `FileChanged` between a failing gate and a passing gate (this is why the `FileChanged` attribution bug in §7.1 mattered).
- `retrieve(query)` scored ranking, `retrieveForFailure(failureName)`, persistence, `dropAll` for sleep-cycle re-ingest.

### 3.6 Event store
- Append-only msgpack trajectory persistence per task/session, `replay()` cursor, SQLite `EventIndex` when `node:sqlite` is available, session summaries, and a live `subscribe()` hook for streaming.
- Writes are synchronous and durable (each event hits the fd before `append` returns and before listeners fire), so there is no stream backpressure to drop; a session switch finalizes the prior session's index row rather than leaving it open.
- CLI: `guppy replay <task> <session>` and `guppy trace <task>` read this back.

### 3.7 Workspace
- Local mode + Docker mode (dockerode); per-workspace container lifecycle with cleanup; path containment on every file tool — `resolve` + prefix check **plus realpath symlink defense** so an in-container symlink can't redirect a host-side file operation outside the worktree; command exec with timeout and output capture.

### 3.8 Bench runner
- 4 configs: `guppy-core` (native), `guppy-prime` (prime-agent), `guppy-pi` (pi adapter), `prime-raw` (raw prime-agent).
- `--dry-run` (materialize + gate without any LLM), `--max-attempts`, `--attempt-timeout`, per-config model/provider/base-url/api-key, `loop-demo`, `sleep-cycle`.
- **Loud spawn failures:** a missing/unlaunchable prime-agent now fails attempt 1 with a red `Failed to launch prime-agent … ENOENT` and breaks the retry loop, instead of recording silent 0-token "failures" (see §7.3).
- Prime-agent resolution: `resolvePrimeBinary()` walks up from the workspace and uses a sibling `prime-agent/` checkout's built CLI when present; otherwise it falls back to a bare `prime-agent` on PATH (which fails loudly on attempt 1, not silently). `--prime-binary <path>` overrides either.
- **ContextOps token-savings:** bridges `estimated_reduction_pct` + the installed ContextOps version and reports `tokensSaved` per capture — in `results.json`, a "Tokens saved (est.)" column in the report's Context table, a per-config line under Summary, an attribution footer (PyPI + version), and the console `Done:` line.

### 3.9 Sleep cycle
- Deterministic failure clustering (normalized signature, pure counting, no LLM): occurrences, `everResolved`, candidate fix files from `extractFixes`, per-cluster session/task ids, ranked report → `report.md`.
- Memory re-ingest (drop + re-distill) so stale memories don't accumulate.

### 3.10 Agent runtime adapters (quarantined)
- `PrimeDaemonRuntime`: spawns the external `prime-agent` binary headless (`--mode json`), frames stdout, parses the JSONL transcript, maps to guppy events + metrics.
- `PiAgentRuntime`: in-process reference adapter delegating to pi-agent-core (A/B baseline only).
- Transcript parser fixed so `FileChanged` is attributed from `tool_execution_start` (see §7.1).

### 3.11 Live streaming
`EventStore.subscribe()` — a listener hook on the single funnel every runtime and the verification engine write to — plus a `live-stream.ts` renderer for all 18 event types (`[task]`, `[model]`, `[tool]`, `[gate]`, `[ckpt]`, …). Default-on in `guppy run` and `guppy chat`; `-q/--quiet` restores summary-only output. Listeners fire synchronously after persist and a throwing listener is caught + logged, so rendering can never break a run.

### 3.12 Interactive chat (`guppy chat` — REPL + fullscreen TUI)
A REPL over the same SessionManager loop: each message is a gated task run (verify → retry → memory), streamed live, with per-turn summaries (outcome, duration, tokens, tool calls, tests) and slash commands — `/help`, `/models [query]` (browse core-compatible models), `/provider [id]` (list/set provider), `/model <id>` (switch model mid-session by rebuilding the runtime), `/verify <0-5>` (6 formal = unsupported), `/exit`. Shares `buildAgentRuntime` with `run`; guarded so `/exit` or EOF mid-turn defers shutdown until the turn lands (regression-tested). On a TTY this becomes a **fullscreen TUI** (pi-tui, MIT — attributed in NOTICE): a scrollable transcript fed by the live event stream, an input dock, a status line, and a `/models` `SelectList` overlay with type-ahead filtering; the same slash commands apply, model/thinking switches rebuild the runtime in place via the shared `createChatEngine`, and the readline REPL remains the non-TTY / `--no-tui` fallback.

### 3.13 Worktree merge-back
On success the agent's changes land in the source repo: git repos get a `commit + merge` (inline Guppy author, your git identity untouched) and the worktree branch is removed; non-git repos get a file mirror including deletions. `--keep-worktree` opts out on either outcome, `--commit-message <template>` (with `{task}`) customizes the commit, and `--no-commit` overlays files with no git history. Failed merges keep the worktree and print its path; `--resume` merges back too.

### 3.14 Model catalog & selection (`@guppy/models`)
A lazy facade over the pi-ai built-in registry (MIT, attributed in NOTICE): `listProviders()` / `listModels()` (search + core-compatibility filter) / `findModel()` / `describeModel()`, plus `selectModel()` / `toModelConfig()` which map a catalog entry into Guppy's own `ModelConfig` — including `buildThinkingBody()`, which emits the per-provider reasoning/thinking request fields pi-ai would send (OpenRouter `reasoning.effort`, DeepSeek `thinking`, OpenAI `reasoning_effort`, …) via `ModelConfig.extraBody`. pi-ai types are confined to this package. Exposed as `guppy models [query]` / `guppy providers` and the chat `/models` `/provider` `/model` commands. `core-compatible` = `openai-completions` API (what the core client can drive); native-only providers (Anthropic, Gemini, OpenAI-responses) are listed but flagged as needing an adapter. Reasoning is exposed as `--thinking <level>` on `run`/`chat` (and `/thinking [level]` in chat), which maps the level to the provider-specific thinking fields (via `selectModel` → `extraBody`) for catalog models with reasoning; unknown/non-reasoning models skip it silently.

### 3.15 Provider config & setup wizard (`~/.guppy/config.json`)
Per-user provider config at `~/.guppy/config.json` (override with `GUPPY_CONFIG`): provider API keys + base-URL presets and a `default` provider/model pair. `guppy setup` is an interactive wizard (pick provider → paste key → optional default model, keys masked on display); `guppy config` shows it, and `guppy config set/remove/path` script it for CI. Runtime precedence is CLI flag > config preset > env var, and the config `default` applies only when *neither* `--model` nor `--provider` is given (an explicit `--provider openrouter` never inherits a default model meant for Groq). Chat mirrors this with `/setup [provider] [key]`. Keys are stored in plaintext with 0600 permissions — the same trade-off as other coding agents.

---

## 4. What works but needs further testing

| Area | Proven | Unproven | Why it matters |
|---|---|---|---|
| **Docker executor** | Image **built and verified** (`guppy/executor:latest`: node 22.23 + git + python3 + make/g++ + pnpm, non-root user); container-mode e2e green (gate inside container, merge-back, crash/resume with orphan reaping); exec timeout honored; `probeContainerRuntime()` fails loudly with a `--local` hint | The image must exist locally before a container run (probe catches it with a build hint); free-tier/offline machines fall back to `--local`; CI skips the container e2e unless the image is built (it's built locally via `pnpm docker:build`) | Sandbox is now a proven launch default; container run requires Docker Desktop running |
| **Model validation** | **6/6 fixtures PASS in one attempt each on OpenRouter free (nemotron-3-super-120b) covering all three kinds (bugfix/testadd/refactor)**; `bugfix-clamp` PASS on Groq free (llama-3.3-70b) after the text-tool-call parser fix; `gemini-2.5-flash` free PASS on a 2/2 smoke | **A full 20-fixture Gemini 2.5 Flash free run scored 4/20 — but 16 of those misses recorded 0 tokens / 0 tool calls** because the model client threw (e.g. 429) and the error was silently masked as a gate failure; that masking is fixed (§7 #13), so a clean re-run is required before citing a breadth number | Validation target is free-tier/open-weight; the loop is proven live on free tiers (nemotron 6/6). The remaining ask is a *clean* full-suite run — the 4/20 Gemini number is contaminated by the silent-failure bug |
| **Rate limiting** | Retry/backoff (429/5xx/network, Retry-After aware, CLI-tunable) **plus a client-side sliding-window limiter** (`--rpm`, process-wide so it holds across the bench's per-task clients); verified it paces 15 req/min cleanly under a mock | **Provider *daily* caps are the binding constraint, not RPM** — measured 2026-08-16: Gemini free = 20 req/**day** (`generate_content_free_tier_requests`), OpenRouter free = 50 req/day/key, Groq = **200k tokens/day** (TPD — the cap that cut the launch run short) + 12k tok/min; `qwen3.6-27b`/`gpt-oss-120b` emit native tool calls and work, `llama-3.3-70b` does not | 20/20 achieved on `qwen3.6-27b` (Groq free, 3 keys) — but only by rotating keys to stay under the 200k TPD cap; token-budget awareness would make it a one-command run |
| **Fixture suite** | 20 fixtures exist (10 `bugfix-*`, 5 `testadd-*`, 5 `refactor-*`); all three kinds exercised (OpenRouter 6/6 smoke, Gemini full-suite run) | Most fixtures never run head-to-head on a single clean model pass; refactor/testadd breadth unproven on a model that can actually code | Bench credibility needs a clean full-suite run |
| **Verification levels** | Levels 0-5 exercised end-to-end (1 tsc, 2 lint via real eslint 9 + hermetic shim, 3 `npm test`, 4 property, 5 integration); LintPassed/Failed events in the store | Level 6 (Dafny) has no setup — **marked unsupported** (CLI rejects `-v 6`); real-eslint run depends on the repo having eslint installed | Gate fidelity at the top of the ladder is now proven; level 6 is a documented non-feature |
| **Prime runtime** | One successful run (89s, 59k tokens — failed to fix); works via OpenRouter | Hangs on custom Ollama provider; flaky on Windows (ipython tool, DOS output); non-zero-exit + partial paths tested but rare | The A/B baseline must be trustworthy |
| **Pi runtime** | Adapter code + types | Never run end-to-end in this environment | Baseline completeness |
| **SQLite EventIndex** | Code path exists; fallback when `node:sqlite` missing | Live-indexed replay untested | Query performance on large stores |
| **Memory over many runs** | Single cross-run retrieval verified in E2E | Accumulation/curation over dozens of runs; retrieval quality at scale | The learning story |
| **Long-horizon tasks** | Runs of ~1–8 min | Multi-hour tasks; context compression mid-run | The stated purpose of the harness |
| **Windows host** | WSL flags for prime; core runs natively | Core on Windows beyond the dev machine's runs | Platform claim |

---

## 5. Broken / incomplete

### 5.1 Resume / checkpointing — wired (local mode)
`guppy run` writes a checkpoint after the baseline gate and after every failed attempt (`<repo>/.guppy/checkpoints/<task>.json`, storing the task, attempt count, failure feedback, last context, worktree path, and — in container mode — the container id). `guppy run --resume` re-attaches that worktree and continues from the next attempt; in container mode it reaps the orphaned container and starts a fresh one bound to the same worktree. Terminal success/exhaustion clears the checkpoint; a crash leaves it on disk.

**Turn-level resume (new):** the runtime now snapshots a full-context cursor at the start of every attempt, and `resumeTask` detects a hard-crashed session (an event log with no terminal `TrajectoryCompleted` plus that snapshot) and resumes the interrupted *conversation* via `CoreAgentRuntime.resume()` instead of restarting the attempt. The runtime reconstructs the exact model-visible message history from the log (via the new `AssistantMessage` event and `ToolReturned.toolCallId`) and continues from the last complete turn — dropping any trailing turn whose tool results were never written (at-least-once semantics: the already-executed tool effects stay in the worktree).

### 5.2 ~~No streaming / live output~~ — ✅ done
`guppy run` now streams every event live (tool calls, model turns, gate results) through an `EventStore.subscribe()` hook — the store is the single funnel every runtime and the verification engine write to, so it covers core/prime/pi and `--resume`. Default-on; `-q/--quiet` restores summary-only output for scripts/CI.

### 5.3 ~~No retry/backoff in the model client~~ — ✅ done
Exponential backoff with jitter on 429/5xx/network errors, Retry-After aware, CLI-tunable (`--max-retries`, `--retry-base-delay-ms`, `--retry-max-delay-ms`), plus a per-request timeout (`--model-timeout-ms`, default 120s) so a hung endpoint can't stall an unattended run.

### 5.4 ~~`guppy benchmark` is a stub~~ — ✅ done
`guppy benchmark` runs the same bench harness as `guppy-bench run`: the hermetic 20-fixture suite by default, or a **SWE-bench / LiveCodeBench JSONL dataset** (`-s swe-bench --dataset <jsonl> --repo <local-checkout>`) via the dataset loader in `@guppy/bench-runner` — instances are materialized by copying the checkout and applying the test patch, then run through the full harness (report, JSON, tokens-saved line). Honest limits: no cloning/building (you supply the checkout), and Python pytest instances need a pytest-capable gate (future work); LiveCodeBench instances are self-contained.

### 5.5 ~~Tools are minimal (4)~~ — ✅ done
Native `search` (ripgrep-backed, with a substring fallback when rg is missing), diff-aware `apply_patch` (unified diff, fuzzy context matching, path containment, multi-file `FileChanged`), and `git_status`/`git_diff`. prime-agent's `ipython` tool stays out — a Windows liability.

### 5.6 ~~Skills are stubbed~~ — ✅ done
`<repo>/.guppy/skills/*.md` skills (front-matter `name`/`description`/`tags` + prompt body) are loaded by `loadSkills`, written by `saveSkill`, selected per-task by the context engine's `selectSkills`, and rendered into the runtime system prompt. Authoring is a first-class CLI command: `guppy skill add <name> <description> [--tags a,b] [--prompt "…"]`, with `guppy skill list` to inspect what a repo teaches. **Distributed skills (Slice 5):** `guppy skill install <name|url|path> [--registry <ref>] [--force]` fetches a skill (builtin registry / URL / local file), validates it, and writes it to `~/.guppy/skills` with `source:`/`installed-at:` provenance; `guppy skill remove <name>` deletes it (per-user first, then the repo dir). Installed skills are merged into every run/chat context by the session manager (repo skills win collisions), so they follow the user across repos.

### 5.7 Per-repo memory only
Memory roots at `<repo>/.guppy/memory`. Cross-repo/shared knowledge is not wired.

### 5.8 ~~Model config polish~~ — ✅ done
`--temperature` / `--max-tokens` flags on `run` + `chat`; the core client streams SSE by default (`--no-stream` to disable), emitting throttled `ModelStreamed` events through the live stream while still accumulating the full response for tool-call parsing.

### 5.9 ~~No interactive mode~~ — ✅ done
`guppy chat` opens an interactive session over the same SessionManager loop — a **fullscreen TUI** on a TTY (scrollable transcript + input dock + status line + `/models` picker) with the readline REPL as the non-TTY fallback. Each message is a gated task run, streamed live, with per-turn summaries, `/help`, `/verify <0-5>` (6 formal = unsupported), and `/exit`.

### 5.10 Defined-but-unused events
`AgentForked`, `AgentMerged`, `CheckpointCreated` exist in the contracts but have no producers. They're a placeholder for the multi-agent future, not a current feature.

### 5.11 ~~Container image never built~~ — ✅ done
`guppy/executor:latest` is built and verified (node 22.23, git, python3, make/g++, pnpm, non-root user). Container-mode runs, resume (with orphan reaping), and merge-back are e2e-tested. `run`/`chat` probe the daemon + image up front and fail with a `--local` hint instead of an obscure dockerode error.

---

## 6. Real-run results (kept as evidence)

| Run | Model | Config | Result |
|---|---|---|---|
| `bugfix-clamp` | nemotron-3-super-120b (OpenRouter free) | **guppy-core** | ✅ PASS, 1 attempt, 46s, 19,022 tokens, 5 tool calls |
| `bugfix-clamp` | nemotron-3-super-120b (OpenRouter free) | guppy-prime | ❌ FAIL, 2 attempts, 113s, 59,034 tokens, 15 tool calls |
| 6 fixtures (bugfix-clamp/sum/average, testadd-math-utils/collections, refactor-rename-clamp) | nemotron-3-super-120b-a12b (OpenRouter free) | guppy-core | ✅ **6/6 PASS, all in 1 attempt, 214,773 tokens, 45 tool calls** |
| `bugfix-clamp` | llama-3.3-70b-versatile (Groq free) | guppy-core | ✅ PASS, 1 attempt — after the `<function/name>` text-tool-call parser fix (was 0/2 before) |
| 2 fixtures (bugfix-clamp/sum) | gemini-2.5-flash (Google AI Studio free) | guppy-core | ✅ 2/2 PASS, 1 attempt each (`smoke-gem`) |
| 20 fixtures (full suite) | gemini-2.5-flash (Google AI Studio free) | guppy-core | ❌ 4/20 PASS — 16 misses recorded 0 tokens (model-client errors silently masked as gate failures; §7 #13, now fixed) |
| 2 fixtures | qwen2.5-coder:1.5b (local Ollama) | guppy-core | 0/2 — loop ran fully (test → tools → gate → retry), model too weak to fix |
| 3 fixtures (bugfix-clamp/sum/average) × {guppy-core, guppy-core-skill} | nemotron-3-super-120b (OpenRouter free) | **skill A/B** | ✅ 6/6 PASS (3/3 each, 1 attempt) — **+0pp pass rate, +9,894 tokens** (81,549 → 91,443): the generic builtin starter skills (code-review/write-tests/commit-hygiene/refactor-rename) were injected into every context but did not change outcomes on fixtures the model already solves; task-specific skills that carry the actual fix DO flip gates — proven hermetically by `guppy-bench skill-demo`. Artifacts: `docs/bench-results/skill-ab-nemotron/` |
| 2 fixtures | qwen2.5-coder:1.5b (local Ollama) | guppy-prime | 0/2, **0 tokens** — prime-agent never reached the model (provider hang) |
| `longhorizon-ledger` (new big-payload fixture) × {no-compress, compress-default, compress-tight} | nemotron-3-super-120b-a12b (OpenRouter free) | **context-compression A/B** | ✅ 3/3 PASS (1 attempt each) — **no-compress 288,496 tok** (7 req, payloads grow to 18.9k) vs **compress default (4k budget, keep 6 recent turns) 578,461 tok** (13 req, 12 tool calls — the recap's lossy results made the model re-read the 47k-char ledger; default retention keeps ~6 turns anyway) vs **compress tight (4k budget, keep 1 recent turn) 203,017 tok** (−30% vs no-compress; 6 req, 5 tool calls, last payload bounded at 13.1k and shrinking). Finding: compression pays off only with tight recent-turn retention; the default keep-6 can *cost* tokens on re-read-heavy tasks. Deterministic control (scripted 24-turn run, keep-1): **87.6% fewer payload tokens**, payloads bounded at ~10.3k vs growing to 120k. **ContextOps view** (auto-scored, contextops 0.3.3): base CHS 68.4 WARN / 82 wasted; compress-default CHS **61.0 FAIL / 52,194 wasted** — 6 of 13 payloads scored FAIL with ~8.6k wasted each (duplicate ledger reads stacked behind the recap); compress-tight CHS 64.7 WARN / **42 wasted**, zero FAIL payloads, lowest waste of all three — the recap system message itself is the only structural cost. Artifacts: `docs/bench-results/compress-ab-nemotron/` (incl. per-payload ContextOps table) |
| `longhorizon-ledger` × {no-compress, deterministic-tight, llm-summary} | nemotron-3-super-120b-a12b (OpenRouter free) | **hybrid compression (capped-verbatim + optional LLM summary)** | ⚠️ partial — **no-compress control FAILED**: 866,731 tok / 167.8s / 14 tool calls, ContextOps **386,597 wasted / CHS FAIL** (context exploded, gate stayed red). The deterministic-tight and llm-summary runs were quota-blocked (429; the 866k run consumed the account's last free requests). Hermetic proof (44 core tests) covers the capped-verbatim recap, the LLM summary, and the deterministic fallback; real numbers land after the daily reset. Artifacts: `docs/bench-results/compress-ab-nemotron/hybrid-nocompress-*` |

Artifacts: every recorded run's `results.json` + `report.md` is committed under `docs/bench-results/<run>/`; the live runtime state under `.guppy/` (event stores, memory, worktrees) is gitignored.

---

## 7. Bug log (found in real testing, all fixed unless noted)

1. **`FileChanged` never emitted on the prime path** (fixed) — parser read the file path from `tool_execution_end`, but prime-agent's documented `tool_execution_end` carries no `args`; the path only exists on `tool_execution_start`. The fix-attribution learning loop was silently dead on prime runs.
2. **Baseline gate could fetch junk from npm** (fixed) — on repos without TypeScript, `npx tsc` downloads a bogus `tsc@2.0.4` package. `levelAvailable()` now skips unavailable levels.
3. **guppy-prime recorded silent 0-token failures** (fixed) — defaulted to a `prime-agent` binary not on PATH; spawn errors were swallowed into gate output. Now resolves a sibling `prime-agent/` checkout's built CLI when present and fails loudly on attempt 1 otherwise.
4. **qwen2.5-coder answers tool requests as fenced JSON text** (fixed) — added a text-embedded tool-call fallback to the OpenAI client (+ unit test).
5. **prime-agent hangs on custom Ollama providers** (open, external) — works via OpenRouter; the hang is inside prime-agent before its first LLM request.
6. **prime-agent's `ipython` tool breaks on Windows** (open, external) — shell commands sent into the Python kernel, WSL-mount and DOS-output glitches; burned 59k tokens without editing a file.
7. **OpenRouter free-tier 429 mid-run** (fixed) — added retry/backoff (§5.3).
8. **`--local` silently ignored** (fixed) — `createSessionManager` minted its own Docker-default workspace manager when none was passed, so `--local` runs still hit the container path; both `run` and `chat` now pass the local-mode manager through.
9. **`git worktree remove` ran from the wrong cwd** (fixed) — silently failed and blocked branch deletion after merge-back; now runs from the owning repo.
10. **`--no-commit` silently ignored** (fixed) — commander parses `--no-commit` as the negation of a `commit` option (`options.commit === false`), not `options.noCommit`.
11. **`/exit`-while-busy crashed the chat REPL** (fixed) — `rl.prompt()` fired after the interface closed; shutdown now defers until the in-flight turn lands (regression-tested for `/exit` and stdin EOF).
12. **Groq llama-3.x answers tool requests as `<function/name>{…}</function>` text** (fixed) — the client only understood a single fenced-JSON object, so a model that emits tool calls as multi-block text (llama-3.3-70b on Groq does this ~40% of the time) was treated as a plain answer and the run "succeeded" without editing anything. The fallback now parses every `<function/name>`, `<function(name)>`, `<function(name){`, and `<function.name>` variant into tool calls (regression-tested against captured real responses; `bugfix-clamp` went 0/2 → PASS after the fix).
13. **Model-client errors were silently recorded as 0-token gate failures** (fixed) — when the OpenAI client threw (429 after retries, network, 4xx), `CoreAgentRuntime` marked the trajectory `failure` with 0 tokens and *no* `ModelCalled` event, and the bench runner then ran the verification gate on top, so `results.json` recorded the gate's red output instead of the real cause. The `gem-full` Gemini 2.5 Flash run (4/20) is contaminated by this: all 16 misses were actually model-client errors, not agent outcomes. Fixed: the runtime now records the error on `TrajectoryCompleted` and the `Trajectory`, and the bench treats a 0-token failure trajectory that carries an error as a loud infrastructure failure — the same class as the prime spawn fix (#3).
14. **Code-review hardening** (fixed) — per-request model timeout so a hung endpoint can't stall a run; realpath symlink defense in workspace path containment (a container-created symlink could redirect host-side file tools outside the worktree); event-store writes switched to synchronous fd writes (no dropped backpressure, durable before listeners fire) and session-switch finalization; merge-back `filesChanged` now counts actual new/modified/deleted files instead of the whole tree; container exec timeout now destroys its stream and truncated docker frames error instead of silently truncating.
15. **`guppy-core-skill` silently routed to the prime runtime** (fixed, 2026-08-19) — the new bench config's runtime branch was `config === 'guppy-core' ? core : prime`, so `guppy-core-skill` fell through to `PrimeDaemonRuntime` and the skill A/B was actually core-vs-prime. Caught on the first real run by the `[PrimeDaemon]` log lines; fixed by routing both core configs to `createCoreRuntime` and pinned with a regression test that hits an unreachable endpoint and asserts the core-style `Model request failed` (a prime run would fail with a spawn error instead).
16. **Context-engine `extractKeywords` didn't strip backticks** (fixed, 2026-08-19) — a task mentioning `` `clamp` `` produced the keyword "`clamp`" (with backticks), so a skill about `clamp` never matched and skills were silently dropped from context — the exact scenario the skill A/B measures. The keyword split now includes the backtick; exposed by `guppy-bench skill-demo` and covered by the demo + context-engine tests.
17. **Default recent-turn retention undermines compression on re-read-heavy tasks** (design finding, 2026-08-19) — `DEFAULT_HISTORY_KEEP_RECENT_TURNS = 6` keeps ~6 model turns verbatim after every recap, so on a task where the model re-reads a big file after recaps, compression fired 6× yet the run used **2× the tokens** of no-compression (578k vs 288k, 12 vs 6 tool calls). With `--history-keep-recent-turns 1` (new bench knob) the same task measured **−30% tokens** vs no-compression. **Resolved:** the recap now keeps the most recent tool result verbatim (capped at 4k chars, `RECAP_LATEST_RESULT_CHARS`) so the model doesn't re-read, plus an optional LLM summarizer (`--history-summary llm`) replaces the recap with a semantic summary (deterministic fallback on failure), and the default retention is now **2** (was 6). See §6 hybrid row.
18. **Unbounded history literally fails long-horizon tasks** (measured, 2026-08-19) — the no-compression control run on `longhorizon-ledger` **FAILED**: 866,731 tokens over 167.8s / 14 tool calls, ContextOps 386,597 wasted tokens (CHS FAIL) — the model re-read the 47k-char ledger until the context exploded and the gate stayed red. Compression is the difference between fail (866k) and pass (prior tight run: 203k, −30%). Artifacts: `docs/bench-results/compress-ab-nemotron/hybrid-nocompress-*`.
19. **`guppy mcp add` had zero input validation** (fixed, 2026-08-19) — `mcp add "" "echo hi"`, `mcp add x ""`, and `mcp add "my server" …` all registered cheerfully and broke at run time. `addMcpServer` now validates (name non-empty + slug-only `[A-Za-z0-9._-]`, command non-empty, command trimmed) and the CLI surfaces a readable error with the usage line (dogfooding finding #1).
20. **`guppy mcp add` silently overwrote duplicates** (fixed, 2026-08-19) — re-adding a name printed "registered" with no warning. Now refuses without `--force` (same rule as `guppy skill install`): "already registered — pass --force to overwrite it", exit 1 (dogfooding finding #2).
21. **`guppy run` masked an unreachable model as a gate failure and burned ~85s on the gate** (fixed, 2026-08-19) — a 0-token model failure (429 after retries) printed the raw error mid-stream but the summary said `Outcome: failure · Tests passed: 0` with a meaningless gate line, after `verifyWithBudget` escalated levels 0→1→3 and ran the repo's unit tests against a run that produced nothing. The session manager now short-circuits a failure trajectory with `error` + 0 tokens + 0 tool calls (same rule as the bench runner, #13) and the `run` summary prints a clear **`Model unreachable`** outcome with the provider error, exit 1; chat renders the same (dogfooding findings #3/#4).
22. **`benchmark --dry-run` read like a failure** (fixed, 2026-08-19) — `Done: 0/1 passed` + `FAIL … fixture red as expected` made the tool look broken when the dry-run verdict was actually correct. Per-task lines are now `CHECK <task>: fixture is red as expected (dry-run OK)` and the summary is `Dry-run OK: N/M fixture(s) red as expected (mutations verified)`, with `exit 1` only when a mutation failed to break the suite; the report gets a dedicated `## Dry-run` section instead of a Failures entry (dogfooding finding #6).
23. **`guppy benchmark` defaulted to a paid model** (fixed, 2026-08-19) — the default was `claude-3-5-sonnet` (provider `openai`) in a tool whose entire purpose is free-tier verification; a no-flag run surprised with a paid-model 401. Defaults are now `openrouter` + `nvidia/nemotron-3-super-120b-a12b:free` in both `guppy benchmark` and `guppy-bench run`, and a non-dry-run with no key for the resolved provider fails up front with `guppy setup` guidance instead of a mid-run 401 (dogfooding finding #6).
24. **Provider base URLs weren't auto-mapped in the core client** (fixed, 2026-08-19) — `provider: 'openrouter'` (or nvidia, groq, …) silently hit `api.openai.com` and 401'd with that provider's key unless `--base-url` was passed manually (hit for real in the compression A/B). `resolveBaseUrl` now maps known providers to their OpenAI-compatible endpoints; an explicit `--base-url` still wins. Pinned with unit tests.
25. **Missing verification tool read two ways** (fixed, 2026-08-19) — the baseline gate said `tool not installed` while the engine said `'tsc' is not installed in this repo` for the same condition. New `levelSkipReason()` is the single wording used by both (dogfooding finding #7).
26. **Gate failures in `guppy run`/`chat` summaries were uninformative** (fixed, 2026-08-19) — a failed gate printed a green `Task completed!` with `Outcome: failure · Tests passed: 0 · Tests failed: 0` (the runtime never runs the tests, so those counts were always 0). The trajectory now carries `lastGatePassed` + `gateErrors` (first few gate messages), the summary header matches the outcome (`Task failed the verification gate` + the actual messages), and the meaningless test-count lines are gone — same in the chat REPL (dogfooding finding #3 residual).

---

## 8. Launch roadmap (phased)

The full plan — blockers, major/minor upgrades, broken edges, and the testing needed for each — lives in [`docs/LAUNCH_CHECKLIST.md`](LAUNCH_CHECKLIST.md). Phase order:

1. **Docs & hygiene** — reconcile STATUS/CAPABILITIES, write the launch checklist, close the chat mid-turn-exit test gap.
2. **Model client hardening** — temperature/max-tokens flags, streaming (SSE) client, dirty-worktree guard for `--no-commit`, a backoff regression test.
3. **Tools** — native search (rg), diff-aware `apply_patch` edit, git status/diff.
4. **~~Skills~~ — ✅ done** — skills-directory loader + `guppy skill add` producer wired through `selectContext` into the runtime system prompt.
5. **~~Verification breadth~~ — ✅ done** — levels 2 (lint), 4 (property), 5 (integration) wired + gated through `guppy run`; level 6 marked unsupported (`-v 6` rejected).
6. **~~Benchmark command~~ — ✅ done** — `guppy benchmark` runs the hermetic suite or a SWE-bench/LiveCodeBench JSONL dataset (loader + materializer + runner plumbing).
7. **~~Sandbox~~ — ✅ done** — executor image built + verified; container-mode task/destroy/resume e2e (incl. orphan reaping); launch default decided: containers (with a loud `probeContainerRuntime()` failure + `--local` fallback).
8. **~~Learning breadth~~ — ✅ done** — cross-repo memory (per-user global fix store) + context compression for long horizons (rolling recap, `--max-history-tokens`).
9. **Validation & launch** — a clean free-tier/open-weight **20-fixture** run (the Gemini 4/20 attempt was polluted by #13; see LAUNCH_CHECKLIST), real live `run` + `chat`, cross-platform CI, commit the tree.

The only remaining **launch gate** is the real-model proof (phase 9's clean **20-fixture** run + a real live `run`/`chat` session); everything else is capability breadth that can ship after.

---

## 9. Summary

| Dimension | Status |
|---|---|
| Core loop (model → tool → gate → retry → memory) | ✅ Working, proven against a real model |
| Standalone (no pi/prime in the default path) | ✅ Achieved |
| Observability (events, replay, trace) | ✅ Working |
| Benchmarking (A/B any config, dry-run, sleep-cycle) | ✅ Working |
| Resilience (resume, backoff, Docker sandbox) | ✅ Resume (incl. container), backoff, container sandbox e2e |
| Breadth (tools, skills, cross-repo memory) | ✅ Tools + skills + cross-repo memory shipped |
| Feel (streaming, interactive mode) | ✅ Streaming + `guppy chat` (REPL + fullscreen TUI) |
| Merge-back (success lands in your repo) | ✅ commit+merge / mirror, `--keep-worktree`, `--no-commit` |
| Context health (token savings) | ✅ ContextOps bridge + report + CLI |
| Long horizons (context compression) | ✅ Rolling recap, `--max-history-tokens`, `ContextCompressed` event |
