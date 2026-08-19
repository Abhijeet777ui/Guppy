# Guppy — Feature Inventory

Everything Guppy does today, organized from the deepest engine layer up. Status is **shipped** unless marked otherwise. Every feature below is implemented, tested, and (where it matters) measured — see `docs/STATUS.md` for evidence.

---

## 0. The loop in one sentence

Guppy owns the whole **context → act → verify → remember → experience** loop in-process: it selects a tight context, drives the model with tools, refuses to call a task done until a real verification gate passes, distills the fix into memory, merges the change into your repo, and learns across repos.

---

## 1. Core runtime (`@guppy/core`) — the brain

| Feature | Details |
|---|---|
| **Provider-agnostic OpenAI-compatible client** | Raw `fetch` to any `/chat/completions` endpoint: OpenRouter, Groq, Google AI Studio, NVIDIA NIM, OpenAI, DeepSeek, Mistral, xAI, Cerebras, Together, Fireworks, Ollama, LM Studio, vLLM, local proxies. |
| **Provider auto-mapping** | Per-provider API-key env resolution *and* base-URL mapping (openrouter → `openrouter.ai/api/v1`, groq → `api.groq.com/openai/v1`, nvidia → `integrate.api.nvidia.com/v1`, …). Explicit `--base-url` always wins. |
| **Streaming** | SSE streaming with throttled `ModelStreamed` events; `--no-stream` for full responses. |
| **Retry/backoff** | Exponential backoff with jitter on 429/5xx/network; Retry-After aware; CLI-tunable; per-request timeout + idle (stall) timeout so a silent endpoint can't hang a run. |
| **Client-side rate limiting** | `requestsPerMinute` pacing under a sliding 60s window — respects free-tier RPM caps instead of tripping them. |
| **Tool-call fallbacks** | Models that answer tool requests as fenced JSON *text* (qwen2.5-coder) or `<function/name>{…}</function>` text (Groq llama-3.x) are still driven as tool-using agents — never silently treated as "done". |
| **Thinking/reasoning passthrough** | `--thinking off|minimal|low|medium|high|xhigh|max` for catalog models that support it. |
| **Native tools** | `search` (rg with substring fallback), `read_file`, `write_file`, `apply_patch` (fuzzy, diff-aware, path-contained), `list_files`, `run_command`, `git_status`, `git_diff`. Read-only mode for the plan phase. |
| **Read-only plan mode** | Only provably non-mutating tools are exposed; external (MCP) tools are dropped. |

## 2. Context compression (long-horizon) — *measured*

The feature that makes 1-hour tasks possible on small-window free-tier models.

| Feature | Details |
|---|---|
| **Rolling recap** | Once estimated history tokens exceed `--max-history-tokens` (default 60k, 0 = off), older turns are replaced by one compact recap: task line, tool calls, and truncated results preserved in order. Deterministic, offline, zero cost, byte-for-byte reproducible. |
| **Verbatim tool-result retention** | The most recent tool result is kept verbatim (capped at 4k chars, `RECAP_LATEST_RESULT_CHARS`) so the model doesn't re-read big files after a recap. |
| **Recent-turn exemption** | The newest 2 turns stay untouched (`DEFAULT_HISTORY_KEEP_RECENT_TURNS = 2`), so the active exchange is never compressed. |
| **Hybrid LLM summary** | `--history-summary llm` rewrites the recap as semantic prose (decisions, findings, what remains) via one summarizer call; any failure falls back to the deterministic recap and records `summarySource: 'deterministic'`. |
| **Instrumentation** | `ContextCompressed` events (turns/messages/tokens before→after, summary source + tokens), `metrics.compressions` on the trajectory, `[compress]` live-stream line. |
| **Measured** | Scripted 24-turn control: **87.6% fewer tokens** (1.5M → 187k), payloads bounded ~10.3k vs 120k. Real-model A/B (`longhorizon-ledger`): **−30% tokens with tight retention**; the no-compression control **failed** at 866k tokens. ContextOps independently confirms: tight compression = structurally cleanest context (42 wasted tokens, zero FAIL payloads). |

## 3. Context engine (`@guppy/context-engine`) — spends tokens where it matters

| Feature | Details |
|---|---|
| **Evidence-first selection** | Files named in errors are must-included; failed-test files promoted; files scored by task-keyword overlap; packed against a token ceiling with cache-aware ordering. |
| **Skill injection** | `selectSkills` scores repo + user skills against task keywords/tags and renders matched ones into the system prompt's `=== SKILLS ===` section. |
| **Memory injection** | Retrieved past fixes (per-repo + cross-repo) scored against the current task and its errors. |
| **Baseline-aware** | The initial context carries the baseline gate's real state — the agent starts knowing what's already broken. |

## 4. Verification engine — the gate (the differentiator)

| Level | Check | Notes |
|---|---|---|
| 0 | Syntax | no-op stand-in |
| 1 | Typecheck | `tsc --noEmit` |
| 2 | Lint | `eslint` |
| 3 | Unit tests (default) | `npm test` |
| 4 | Property tests | `npm run test:property --if-present` |
| 5 | Integration tests | `npm run test:integration --if-present` |
| 6 | Formal | unsupported (CLI rejects) |

- Per-level parsers (tsc, eslint, vitest/spec, TAP) turn raw output into structured per-file/per-test errors.
- `levelAvailable()` skips missing tools cleanly (no `npx` junk-fetching).
- Escalating ladder: stricter levels run only while looser ones pass.
- **Baseline gate** pre-run; failure feedback (errors + test results) feeds the next attempt's context automatically.
- **Only a green gate = success**; a run that "passes" has real `npm test` output to prove it.

## 5. Session manager — the gated retry loop

| Feature | Details |
|---|---|
| **Gated retry loop** | Attempt → gate → fail → feedback → next attempt, up to `--max-turns`; the harness, not the model, declares victory. |
| **Failure feedback** | Gate errors + failed tests + retrieved past fixes injected into the next attempt's context. |
| **Checkpoints + resume** | Per-attempt checkpoint under `.guppy/checkpoints`; `--resume` restarts from the last attempt (container-aware: reaps orphaned containers). Crash-safe long runs. |
| **Model-unreachable short-circuit** | A failure with 0 tokens / 0 tool calls (429, bad key) skips the gate entirely and reports `Model unreachable` — no more burning ~85s gating a run that produced nothing. |
| **Gate-aware results** | Trajectories carry `lastGatePassed` + `gateErrors`, so summaries say *why* a task failed. |
| **Merge-back** | Success = commit + merge the worktree into your repo (`--commit-message '{task}'`, `--no-commit` overlay, `--keep-worktree`). |
| **Cross-repo memory wiring** | Fixes distill into the repo store and the global user store; reads merge both. |

## 6. Memory (`@guppy/memory`) — learns across runs

| Feature | Details |
|---|---|
| **Fix distillation** | A `FileChanged` between a failing and passing gate becomes a `fix` memory (failure + diff). Pure and deterministic — no LLM in learning. |
| **Retrieval scoring** | `retrieveForFailure` ranks memories against the current task/errors. |
| **Per-repo + global stores** | `<repo>/.guppy/memory` for repo-local; `~/.guppy/memory` (`GUPPY_MEMORY_DIR`) for cross-repo — a fix learned in repo A is retrieved in repo B. Same id across stores; primary wins dedupe; `count`/`clear` span both. |

## 7. Skills (`@guppy/skills`) — teach conventions

| Feature | Details |
|---|---|
| **Authoring** | `guppy skill add <name> <description> --tags … --prompt …` writes `<repo>/.guppy/skills/<slug>.md`. |
| **Distribution** | `guppy skill install` from the bundled registry, any https URL, a local path, or a custom `--registry` (URL/file/inline JSON). Provenance front-matter (`source:`, `installed-at:`); duplicates refuse without `--force`. |
| **User-level installs** | `~/.guppy/skills` reach every repo; repo skills win name collisions. |
| **Impact measured** | `guppy-bench skill-demo` proves a task-specific skill in context flips the gate; the `guppy-core-skill` A/B reports pass-rate pp + token deltas. |

## 8. MCP servers (`@guppy/mcp`) — bring your own tools

| Feature | Details |
|---|---|
| **Registration** | `guppy mcp add/list/remove`; stdio servers; config at `~/.guppy/mcp.json`. Name/command validation + duplicate refusal (`--force`). |
| **Sandboxing** | Servers start inside the workspace with a scrubbed environment (no API keys/tokens) and are tree-killed at session end — proven by a hostile-server test. "Containment, not a jail." |
| **Loop integration** | Server tools join the native tool set with identical events/result plumbing; broken servers skip without failing the session. |

## 9. Sandbox (`@guppy/workspace`)

| Feature | Details |
|---|---|
| **Docker default** | `guppy/executor:latest` (node 22, git, python3, make/g++, pnpm, non-root user); container exec bug fixed (frame-splitting the multiplexed stream, honoring timeouts). |
| **Local mode** | `--local` = plain host worktrees, no Docker. |
| **Path containment** | Every file tool resolves + checks the worktree prefix at one choke point; symlink defense (a container-created symlink can't redirect host file tools outside the worktree). |
| **Loud probe** | `probeContainerRuntime()` fails with "start Docker Desktop or use --local" instead of an obscure dockerode error. |

## 10. Event store + audit

| Feature | Details |
|---|---|
| **Typed event stream** | `TaskStarted → ContextSelected → ModelCalled → ToolCalled → ToolReturned → FileChanged → TestPassed/Failed → VerificationEscalated → ContextCompressed → PlanProduced/PlanRevised → TrajectoryCompleted`. |
| **Durability** | Append-only msgpack, synchronous fd writes (durable before listeners fire), SQLite index, session finalization, periodic snapshots. |
| **Replay/trace** | `guppy replay <task> <session>`, `guppy trace <task>` with session/type filters. |
| **Live stream** | `EventStore.subscribe()` drives the run/chat terminal output; `-q/--quiet` suppresses. |

## 11. UX — TUI + REPL

| Feature | Details |
|---|---|
| **Fullscreen TUI** | Scrollable transcript + markdown replies, persistent context bar (repo · model · verify · mode · think · saved), per-turn footer (✓/✗/✕ marks, duration, tokens, tool calls, tests, savings), activity spinner, `/model` type-ahead picker with ctx/max/reasoning metadata, `/theme dark|light`. |
| **REPL fallback** | Readline mode for piped/CI stdin. |
| **Plan/build mode** | `/plan` read-only turns, plan-gate footer, `/build` approval, `/edit` revision (with `PlanRevised` audit). |
| **Interrupts** | Ctrl+C cancels the in-flight turn cleanly (lands `cancelled`), second Ctrl+C exits; `/exit`/EOF mid-turn finish the turn then shut down. |
| **Session goodbye** | `N turns · tokens · tool calls · tests` summary (tokens only, never money). |
| **Headless-verified** | 57 UI tests incl. rendered screen-grid dumps of every major state. |

## 12. Benchmark & analysis (`guppy-bench`)

| Feature | Details |
|---|---|
| **Hermetic suite** | 21 fixtures (bugfix / test-add / refactor + `longhorizon-ledger`), each clean-green/mutated-red verified by `sanity`. |
| **A/B configs** | `guppy-core`, `guppy-core-skill`, `guppy-prime`, `guppy-pi`, `prime-raw`. |
| **Deterministic demos** | `loop-demo` (close-the-loop), `skill-demo` (skill flips the gate) — no LLM, no network. |
| **Dry-run** | Materialize + gate with zero tokens; `CHECK`/`Dry-run OK` verdicts. |
| **Datasets** | SWE-bench / LiveCodeBench JSONL import (`-s swe-bench --dataset … --repo …`). |
| **ContextOps scoring** | Every payload captured + scored by the context-health linter: CHS, wasted tokens, tokens saved (est.) per config; per-payload detail. |
| **Sleep cycle** | Offline failure clustering across sessions: recurrence, ever-resolved?, candidate fixing files. |
| **Free-tier by default** | Defaults to openrouter + free nemotron; keyless preflight with setup guidance. |

## 13. Provider catalog & config

| Feature | Details |
|---|---|
| **Catalog** | 39 providers / 1,200+ models with cost, context window, max tokens, reasoning, core-compatibility flags. |
| **Setup wizard** | `guppy setup` — pick provider, paste key, pick default model. |
| **Config** | `~/.guppy/config.json` (0600); `guppy config set/remove/path`; key masking everywhere. |

## 14. Status legend

- **Shipped and green:** everything above. Build clean; **290 tests / 14 suites**; live proof on free tiers (6/6 nemotron PASS, Groq PASS, skill A/B, compression A/Bs, 21/21 fixture sanity).
- **Planned (roadmap):** multi-agent fork/merge (event types exist in contracts), multimodal input, cache-aware token accounting, provider presets, cross-platform CI, a clean full-suite free-tier breadth run.
- **Launch gate:** a clean 20+ fixture free-tier run, a recorded real `run`/`chat` session, TUI visual sign-off, commit/push, CI.
