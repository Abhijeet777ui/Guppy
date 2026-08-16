# Guppy — Project Status Report

**Date:** August 16, 2026
**Scope:** All `packages/*` and `apps/*` in the guppy workspace, plus the `prime-agent/` integration used as an A/B baseline.
**Headline:** The learn → act → verify → remember loop is **working and proven against a real model**, and the product loop is now closed — a successful run **merges the agent's changes back into your repo**. Resilience (resume, retry), feel (streaming, chat), tools (search/apply_patch/git), skills (loader + `guppy skill add`), and the **Docker sandbox** (built + container-mode e2e) are shipped; what remains is proving the loop at scale on **free-tier / open-weight models** (no paid key required — the launch target is exactly a student/individual budget).

---

## 1. How this report was verified

Every claim below was checked against the current tree, not memory:

- **Build:** `pnpm -r run build` — green across all 11 workspace projects.
- **Tests:** `pnpm -r run test` (root `pnpm test`) — green end-to-end; 137 tests across 10 suites (only `contracts` passes via `--passWithNoTests`):

  | Suite | Tests | Covers |
  |---|---|---|
  | `@guppy/core` | 28 | OpenAI client (request shape, auth, errors, fenced-JSON + `<function/name>` text-tool-call fallbacks, assistant `tool_calls.type` normalization, streaming SSE, backoff, per-request timeout, sliding-window rate limiter), full core tool loop E2E, rich tools (search/apply_patch/git) |
  | `@guppy/workspace` | 7 | unified-diff parser + fuzzy hunk applier, symlink path containment |
  | `@guppy/agent-runtime` | 3 | prime-agent spawn → JSONL framing → parse → events E2E; non-zero exit; missing binary |
  | `@guppy/verification-engine` | 9 | level commands, output parsers (incl. real-eslint stylish), escalation |
  | `@guppy/event-store` | 11 | append/replay roundtrip + enrichment, replay `fromIndex`/filter, durability across close/reopen, session auto-begin + finalization (unknown on switch, real outcome on `TrajectoryCompleted`), trajectory metrics, live subscribe + throwing-listener isolation, checkpoints, SQLite index queries + task deletion |
  | `@guppy/memory` | 13 | record/count/clear, persistence across instances, corrupt-line tolerance, tag/type/taskId/limit retrieval + recency decay, `retrieveForFailure`, `ingestTrajectory`, `extractFixes` (failure→change→pass, unresolved, typecheck, over-attribution) |
  | `@guppy/sleep-cycle` | 6 | failure clustering, fix extraction, memory re-ingest |
  | `@guppy/context-engine` | 8 | skills loader/producer/selection |
  | `@guppy/control-plane` | 31 | full standalone loop, resume, checkpoint, live-stream, chat (incl. mid-turn-exit), worktree merge-back, skills E2E, verification levels 2/4/5 E2E, container-mode E2E (skipped without Docker or the locally-built executor image) |
  | `@guppy/bench-runner` | 21 | context-health/tokens-saved bridge, dry-run wiring, prime binary resolution, loud spawn failures + loud model-client error surfacing, dataset loaders + materialization |

- **Real-model runs:**
  - `qwen2.5-coder:1.5b` via local Ollama (free, offline) — both runtimes, 2 fixtures (0/2 — too weak).
  - `nvidia/nemotron-3-super-120b-a12b:free` via OpenRouter (real API key) — **6/6 fixtures PASS in one attempt each** (bugfix-clamp/sum/average, testadd-math-utils/collections, refactor-rename-clamp; 214,773 tokens, 45 tool calls).
  - `llama-3.3-70b-versatile` via Groq free — `bugfix-clamp` PASS after the `<function/name>` text-tool-call parser fix; 100k TPD cap exhausted same day (a fixture run needs ~100k tokens).
  - `gemini-2.5-flash` via Google AI Studio free — 2/2 smoke (`bugfix-clamp` + `bugfix-sum`) PASS; a later **full 20-fixture run scored 4/20**, but 16 of those misses recorded 0 tokens / 0 tool calls because the model client threw and the error was silently masked as a gate failure — see §7 #13 (fixed).
  - `qwen/qwen3.6-27b` via Groq free (2026-08-16) — **11/20 fixtures PASS** (55%; the 11 passes in 1-2 attempts, 174,575 tokens, 46 tool calls). Cut short by Groq's **200k tokens/day** free cap: 8 fixtures quota-blocked (5 never started, 3 partial), 1 genuine fail (`bugfix-truncate` — the model emitted a non-standard `<parameter=…>` tool-call format Groq rejected with a 400). Evidence: `docs/bench-results/launch-qwen-groq/`.

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

apps/
  control-plane/      685 lines   `guppy` CLI: run / chat / replay / trace / benchmark; SessionManager + live-stream
  bench-runner/      2322 lines   `guppy-bench` CLI: list / sanity / run / loop-demo / sleep-cycle
  sleep-cycle/        437 lines   Offline failure clustering + report + memory curation
```

The only pi/prime coupling left is `agent-runtime` (both adapters are opt-in behind `--runtime prime|pi`) and a type-only `Model` import used by those opt-in paths. The default path — `guppy run --runtime core` — has **zero** pi/prime dependencies.

---

## 3. What works (verified)

### 3.1 The standalone core loop (`@guppy/core`)
- `ModelConfig` with provider → env-var key resolution (`openai`, `openrouter`, `nvidia`, `prime`, `anthropic`).
- `OpenAIChatClient.complete()` over raw `fetch` to any `/chat/completions` endpoint: messages + tool definitions, native `tool_calls` parsing, **fenced-JSON tool-call fallback** (needed for qwen2.5-coder, which answers tool requests as JSON text), token usage, descriptive HTTP errors.
- `CoreAgentRuntime` implements `AgentRuntime`: builds a system prompt from selected context (files, test results, errors, memories, skills), loops model ↔ tools up to `maxTurns`, emits `TaskStarted / ModelCalled / ToolCalled / ToolReturned / FileChanged / TrajectoryCompleted`, accumulates token/tool metrics, maps completion to `success | partial | failure`.
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

### 3.12 Interactive chat (`guppy chat`)
A REPL over the same SessionManager loop: each message is a gated task run (verify → retry → memory), streamed live, with per-turn summaries (outcome, duration, tokens, tool calls, tests) and `/help`, `/verify <0-5>` (6 formal = unsupported), `/exit`. Shares `buildAgentRuntime` with `run`; guarded so `/exit` or EOF mid-turn defers shutdown until the turn lands (regression-tested).

### 3.13 Worktree merge-back
On success the agent's changes land in the source repo: git repos get a `commit + merge` (inline Guppy author, your git identity untouched) and the worktree branch is removed; non-git repos get a file mirror including deletions. `--keep-worktree` opts out on either outcome, `--commit-message <template>` (with `{task}`) customizes the commit, and `--no-commit` overlays files with no git history. Failed merges keep the worktree and print its path; `--resume` merges back too.

---

## 4. What works but needs further testing

| Area | Proven | Unproven | Why it matters |
|---|---|---|---|
| **Docker executor** | Image **built and verified** (`guppy/executor:latest`: node 22.23 + git + python3 + make/g++ + pnpm, non-root user); container-mode e2e green (gate inside container, merge-back, crash/resume with orphan reaping); exec timeout honored; `probeContainerRuntime()` fails loudly with a `--local` hint | The image must exist locally before a container run (probe catches it with a build hint); free-tier/offline machines fall back to `--local`; CI skips the container e2e unless the image is built (it's built locally via `pnpm docker:build`) | Sandbox is now a proven launch default; container run requires Docker Desktop running |
| **Model validation** | **6/6 fixtures PASS in one attempt each on OpenRouter free (nemotron-3-super-120b) covering all three kinds (bugfix/testadd/refactor)**; `bugfix-clamp` PASS on Groq free (llama-3.3-70b) after the text-tool-call parser fix; `gemini-2.5-flash` free PASS on a 2/2 smoke | **A full 20-fixture Gemini 2.5 Flash free run scored 4/20 — but 16 of those misses recorded 0 tokens / 0 tool calls** because the model client threw (e.g. 429) and the error was silently masked as a gate failure; that masking is fixed (§7 #13), so a clean re-run is required before citing a breadth number | Validation target is free-tier/open-weight; the loop is proven live on free tiers (nemotron 6/6). The remaining ask is a *clean* full-suite run — the 4/20 Gemini number is contaminated by the silent-failure bug |
| **Rate limiting** | Retry/backoff (429/5xx/network, Retry-After aware, CLI-tunable) **plus a client-side sliding-window limiter** (`--rpm`, process-wide so it holds across the bench's per-task clients); verified it paces 15 req/min cleanly under a mock | **Provider *daily* caps are the binding constraint, not RPM** — measured 2026-08-16: Gemini free = 20 req/**day** (`generate_content_free_tier_requests`), OpenRouter free = 50 req/day/key, Groq = **200k tokens/day** (TPD — the cap that cut the launch run short) + 12k tok/min; `qwen3.6-27b`/`gpt-oss-120b` emit native tool calls and work, `llama-3.3-70b` does not | A clean 20-fixture run costs ~140-200 requests (≈6-7 req/fixture measured) — ~2-3 OpenRouter key-days, or one short paid run |
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

### 5.2 ~~No streaming / live output~~ — ✅ done
`guppy run` now streams every event live (tool calls, model turns, gate results) through an `EventStore.subscribe()` hook — the store is the single funnel every runtime and the verification engine write to, so it covers core/prime/pi and `--resume`. Default-on; `-q/--quiet` restores summary-only output for scripts/CI.

### 5.3 ~~No retry/backoff in the model client~~ — ✅ done
Exponential backoff with jitter on 429/5xx/network errors, Retry-After aware, CLI-tunable (`--max-retries`, `--retry-base-delay-ms`, `--retry-max-delay-ms`), plus a per-request timeout (`--model-timeout-ms`, default 120s) so a hung endpoint can't stall an unattended run.

### 5.4 ~~`guppy benchmark` is a stub~~ — ✅ done
`guppy benchmark` runs the same bench harness as `guppy-bench run`: the hermetic 20-fixture suite by default, or a **SWE-bench / LiveCodeBench JSONL dataset** (`-s swe-bench --dataset <jsonl> --repo <local-checkout>`) via the dataset loader in `@guppy/bench-runner` — instances are materialized by copying the checkout and applying the test patch, then run through the full harness (report, JSON, tokens-saved line). Honest limits: no cloning/building (you supply the checkout), and Python pytest instances need a pytest-capable gate (future work); LiveCodeBench instances are self-contained.

### 5.5 ~~Tools are minimal (4)~~ — ✅ done
Native `search` (ripgrep-backed, with a substring fallback when rg is missing), diff-aware `apply_patch` (unified diff, fuzzy context matching, path containment, multi-file `FileChanged`), and `git_status`/`git_diff`. prime-agent's `ipython` tool stays out — a Windows liability.

### 5.6 ~~Skills are stubbed~~ — ✅ done
`<repo>/.guppy/skills/*.md` skills (front-matter `name`/`description`/`tags` + prompt body) are loaded by `loadSkills`, written by `saveSkill`, selected per-task by the context engine's `selectSkills`, and rendered into the runtime system prompt. Authoring is a first-class CLI command: `guppy skill add <name> <description> [--tags a,b] [--prompt "…"]`, with `guppy skill list` to inspect what a repo teaches.

### 5.7 Per-repo memory only
Memory roots at `<repo>/.guppy/memory`. Cross-repo/shared knowledge is not wired.

### 5.8 ~~Model config polish~~ — ✅ done
`--temperature` / `--max-tokens` flags on `run` + `chat`; the core client streams SSE by default (`--no-stream` to disable), emitting throttled `ModelStreamed` events through the live stream while still accumulating the full response for tool-call parsing.

### 5.9 ~~No interactive mode~~ — ✅ done
`guppy chat` opens a REPL over the same SessionManager loop: each message is a gated task run, streamed live, with per-turn summaries, `/help`, `/verify <0-5>` (6 formal = unsupported), and `/exit`.

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
| 2 fixtures | qwen2.5-coder:1.5b (local Ollama) | guppy-prime | 0/2, **0 tokens** — prime-agent never reached the model (provider hang) |

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
8. **Learning breadth** — cross-repo memory + context compression for long horizons.
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
| Breadth (tools, skills, cross-repo memory) | ⚠️ Tools + skills shipped; cross-repo memory remains |
| Feel (streaming, interactive mode) | ✅ Streaming + `guppy chat` |
| Merge-back (success lands in your repo) | ✅ commit+merge / mirror, `--keep-worktree`, `--no-commit` |
| Context health (token savings) | ✅ ContextOps bridge + report + CLI |
