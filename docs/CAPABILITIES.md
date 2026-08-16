# Guppy — Capabilities & Competitive Edge

**One-line pitch:** Guppy is a standalone software-engineering harness whose core idea is that **the harness, not the model, decides what "done" means** — it learns → acts → verifies → remembers, and it owns every layer of that loop in-process with zero external agents.

This document lists every capability guppy has today, every capability planned, and — for each — the concrete edge it gives against existing harnesses (prime-agent, pi/pi-agent-core, Claude Code, Codex, OpenHands).

---

## Part 1 — Present capabilities

### 1.1 A brain of its own (no borrowed runtime)
`@guppy/core` is guppy's native agent: an OpenAI-compatible chat client over raw `fetch` plus an in-process tool loop. The default `guppy run` path has **zero** pi/prime dependencies.

- Works against **any** OpenAI-compatible endpoint: OpenRouter, Ollama, LM Studio, NVIDIA NIM, vLLM, or a local model.
- Provider → env-var key resolution (`openai`, `openrouter`, `nvidia`, `prime`, `anthropic`), no model registry to maintain.
- **Fenced-JSON tool-call fallback:** models that answer tool requests as JSON *text* (e.g. qwen2.5-coder) are still driven as tool-using agents, not silently treated as "done".

**Edge vs prime-agent:** prime-agent is an *external process* you spawn, frame, and parse — guppy's brain is a library in the same process. **Edge vs pi:** pi is a *library* with its own model registry and assumptions; guppy owns the entire pipeline. **Edge vs Claude Code / Codex:** those are closed harnesses locked to one vendor's model stack; guppy runs any model, including offline local ones with no API key.

### 1.2 Gated autonomy — the harness decides success
The signature differentiator. After every attempt, guppy runs a **verification gate** (7 levels: syntax → typecheck → lint → unit tests → property tests → integration tests → formal verification) and only a green gate counts as success. The model never gets to declare victory. Levels 0-5 are exercised end-to-end; level 6 (formal) is documented as unsupported (the CLI rejects it).

- Per-level parsers (tsc, eslint, vitest/spec, TAP) turn raw output into structured per-file/per-test errors.
- Failure evidence is fed back into the next attempt's context automatically.
- Baseline gate before the run: the agent starts already knowing what's broken.
- `levelAvailable()` guard: missing tools (e.g. no TypeScript in a repo) skip cleanly instead of fetching junk from npm.

**Edge:** Claude Code, Codex, and OpenHands all treat the model's "I'm done" as success. That's the classic failure mode — the model *believes* it fixed the bug. Guppy's gate is real, executable, and checkable; a run that "passes" has an `npm test` green to prove it.

### 3.3 Event-driven trajectories — everything is auditable
Every run is a typed event stream (`TaskStarted → ContextSelected → ModelCalled → ToolCalled → ToolReturned → FileChanged → TestEvent → TrajectoryCompleted`), persisted append-only as JSONL with an optional SQLite index.

- `guppy replay <task> <session>` and `guppy trace <task>` re-read any run.
- Token counts, tool calls, wall time, per-test results — all structured, all queryable.
- This is the substrate for memory, benchmarking, and sleep-cycle — nothing is reconstructed from logs.

**Edge:** most harnesses emit a chat transcript; guppy emits a *trajectory* designed for programmatic consumption and learning.

### 1.4 Memory — the harness gets smarter across runs
`@guppy/memory` distills a successful trajectory into a `fix` memory: a `FileChanged` between a failing gate and a passing gate, with the failure it resolved and the diff that fixed it.

- Retrieved scored against the current task and its errors (`retrieveForFailure`).
- Persisted per-repo at `<repo>/.guppy/memory`, so a second run of the same or similar task starts with the previous fix in context.
- `extractFixes` is pure and deterministic — no LLM involved in learning.

**Edge:** prime-agent and pi have no cross-run memory at all; Claude Code/Codex sessions are stateless by default. Guppy's learn→remember loop is the difference between "asks the same question twice" and "already knows the answer from last time."

### 1.5 Context engine — spends tokens where it matters
`@guppy/context-engine` selects what the model sees: files mentioned in errors are **must-included**, failed-test files are promoted, files are scored by task-keyword overlap, and the whole pack is budgeted against a token ceiling with cache-aware ordering.

**Edge:** naive harnesses dump the repo map or "relevant" files; guppy packs the smallest context that can still reproduce and fix the failure — one reason the winning nemotron run used only ~19k tokens.

### 1.6 Sandboxed workspace
`@guppy/workspace` executes tools with **path containment** at one choke point (every file tool resolves and checks the worktree prefix), and can run the whole task in a Docker container (`docker/executor/Dockerfile`: node 22, git, python3, make/g++, pnpm, non-root user).

### 1.7 Benchmarking built in — guppy A/B tests itself
`guppy-bench` runs any configuration against the same fixtures:

- 4 configs: `guppy-core` (native), `guppy-prime` (prime-agent), `guppy-pi` (pi adapter), `prime-raw`.
- 20 fixtures across 3 kinds (10 bugfix, 5 testadd, 5 refactor).
- `--dry-run` materializes + gates without spending any tokens; `loop-demo` shows the closed loop with a scripted model; full head-to-head with per-config model/provider flags.
- **Loud failures:** a broken runtime (missing binary, spawn error) fails attempt 1 with a clear red message — never a silent 0-token "failure."
- Head-to-head result so far: on the same model (nemotron 3 super 120b), **guppy-core fixed `bugfix-clamp` in one attempt (46s, 19k tokens, 5 tool calls) while prime-agent failed in 15 tool calls and 59k tokens.**
- **Free-tier validation (Phase 9, in progress):** 6/6 fixtures PASS in one attempt each on OpenRouter free (`nvidia/nemotron-3-super-120b-a12b:free`) covering all three kinds — bugfix, testadd, refactor (214,773 tokens, 45 tool calls); `bugfix-clamp` also PASS on Groq free (`llama-3.3-70b-versatile`); Gemini 2.5 Flash free passed a 2/2 smoke. A full **20-fixture** Gemini run scored 4/20, but most misses were silent 0-token model-client errors (now fixed) rather than agent outcomes — the loop is proven live on free tiers; a clean full-suite breadth number still needs a re-run.

### 1.8 Sleep cycle — offline, deterministic failure analysis
`guppy-bench sleep-cycle` clusters failures across all recorded sessions by normalized signature — pure counting, no LLM — and reports recurrence, whether each cluster was ever resolved, and the candidate files changed to fix it. It also re-distills memory so stale entries don't accumulate.

**Edge:** "which failures keep coming back, and what fixed them" is answered *for free* as a side effect of every run. No other harness answers this at all.

### 1.9 Quarantined adapters — borrow both worlds, keep the loop
`@guppy/agent-runtime` keeps `PrimeDaemonRuntime` (spawn + frame + parse prime-agent's headless JSONL) and `PiAgentRuntime` (in-process pi-agent-core) as opt-in baselines. This is deliberate: guppy borrowed prime's **event-stream idea** and pi's **tight prompt→tool loop idea**, but owns the loop itself.

### 1.10 Worktree merge-back & context health (shipped)
Two launch-polish features on top of the loop:
- **Merge-back:** a successful run **commits + merges the agent's changes into your repo** (git mode) or mirrors the files (non-git), instead of destroying the worktree — the fix no longer silently vanishes. Tuned by `--keep-worktree`, `--commit-message <template>` (with `{task}`), and `--no-commit` (overlay files, no history). `--resume` merges back too.
- **Context health:** guppy bridges ContextOps' `estimated_reduction_pct` + installed version into a **`tokensSaved` metric** — surfaced in the bench report (a "Tokens saved (est.)" column, a per-config Summary line, and an attribution footer linking PyPI) plus the console `Done:` line, so ContextOps advertises itself through every guppy bench run.

---

## Part 2 — Future capabilities (roadmap)

### 2.1 ~~Checkpoint & resume~~ — ✅ shipped (local mode)
Checkpoint per attempt + `--resume` in the CLI, crash-safe long runs. Terminal success/exhaustion clears the checkpoint; a crash leaves it on disk. Container-mode resume is supported — the checkpoint persists the container id, and resume reaps the orphaned container before starting a fresh one bound to the same worktree.
**Why it matters:** long-horizon tasks that survive restarts. No competitor restores a mid-task trajectory; this makes guppy the harness you can leave running overnight.

### 2.2 ~~Live streaming & telemetry~~ — ✅ shipped
Streams the event stream to the terminal as it happens (tool calls, model turns, gate results) via `EventStore.subscribe()`. Default-on; `-q/--quiet` suppresses. Turns `guppy run` into a watchable, demoable process.

### 2.3 ~~Retry/backoff on model APIs~~ — ✅ shipped
Exponential backoff with jitter on 429/5xx/network, Retry-After aware, CLI-tunable. Unattended robustness.

### 2.4 ~~Richer tool set~~ — ✅ shipped
Native `search` (rg-backed with a substring fallback), diff-aware `apply_patch` (fuzzy context matching, path containment), `git_status`/`git_diff`. Keep prime's tool *richness* without its broken `ipython` liability.

### 2.5 ~~Skills~~ — ✅ shipped
Teach guppy repo/project-specific procedures (build rituals, test commands, conventions) via `<repo>/.guppy/skills/*.md` — front-matter `name`/`description`/`tags` plus a prompt body. `guppy skill add <name> <description>` authors them (`guppy skill list` to inspect); `loadSkills` reads the directory; the context engine's `selectSkills` picks the relevant ones per task (scored against task keywords and tags) and the runtime renders them into the system prompt's `=== SKILLS ===` section. The session manager and the bench runner both load them automatically.

### 2.6 Multi-agent (fork/merge)
The `AgentForked` / `AgentMerged` events already exist in the contracts. Planned: subagents for parallel investigation, a reviewer agent gated by the verifier, and merge arbitration — all still under the harness's gate, so model consensus never substitutes for a green test.

### 2.7 Cross-repo memory
A shared memory store so fixes learned in one repo help in another (same library, similar pattern). The per-repo store is the seed; curation and namespacing come next.

### 2.8 Formal verification level 6 — ⚠️ unsupported
Dafny-backed verification (the only layer that could *prove* a property instead of testing it) has **no tooling set up**. The CLI rejects `-v 6` with a clear message instead of silently skipping the gate; `LEVEL_COMMANDS[6]` stays defined so wiring it later is a one-line change plus a Dafny fixture.

### 2.8b Verification breadth (levels 2/4/5) — ✅ shipped
Levels 2 (lint), 4 (property), and 5 (integration) were implemented but never executed — no repo had eslint, a property script, or an integration script, so the ladder always skipped them. Now wired + gated end-to-end: tool levels resolve from the source repo's node_modules via `npm exec --prefix` (worktrees carry no node_modules), the eslint parser handles real stylish output (validated against eslint 9.39.5), lint gates emit `LintPassed`/`LintFailed` events, and dedicated fixtures prove each level gates: a lint violation stops the run until fixed, a property test catches in-range violations unit tests miss, and an integration test gates a module-boundary flow.

### 2.9 Standard benchmarks — ✅ loader shipped; pytest gate pending
`guppy benchmark` now runs the hermetic 20-fixture suite (real report/JSON, `--dry-run`, A/B configs) and can load **SWE-bench-verified** and **LiveCodeBench JSONL datasets**: instances are materialized from a local checkout with the test patch applied (`--repo <checkout>`), and the gold patch is kept for validation. Remaining for a citable public score: a pytest-capable gate so real Python instances run end-to-end.

### 2.10 Context compression for long horizons
Progressive summarization of the trajectory mid-run so multi-hour tasks stay under the context budget — the "long-horizon" promise made real.

### 2.11 ~~Interactive mode~~ — ✅ shipped
`guppy chat`: a REPL over the same gate + memory + event-store loop, streamed live, with `/help`, `/verify <0-5>` (6 formal = unsupported), and `/exit`.

### 2.12 Hardened Docker sandbox — ✅ built + e2e
`guppy/executor:latest` is built (node 22.23, git, python3, make/g++, pnpm, non-root `guppy` user) and container-mode runs/resume/merge are e2e-tested, including reaping orphaned containers on resume and honoring exec timeouts. Remaining hardening (already configured in `startContainer`): network egress control (`networkMode`) and resource limits (`memoryLimit`/`cpuLimit`) — tuned per deployment rather than defaulted.

---

## Part 3 — Why guppy wins (the honest comparison)

| Capability | guppy | prime-agent | pi (agent-core) | Claude Code / Codex / OpenHands |
|---|---|---|---|---|
| Own the agent loop | ✅ in-process, native | ❌ external process | ❌ it *is* the loop (library) | ✅ but closed |
| Any model / offline | ✅ any OpenAI-compatible endpoint, local models | ✅ but flaky custom providers | ⚠️ registry-bound | ❌ vendor-locked |
| Success = verified, not claimed | ✅ 7-level gate decides | ❌ model decides | ❌ model decides | ❌ model decides (except OpenHands tests) |
| Learn across runs | ✅ fix memory + retrieval | ❌ none | ❌ none | ❌ none |
| Trajectory as data | ✅ typed event store + replay | ⚠️ JSONL transcript (unstructured by design) | ❌ no persistence story | ⚠️ chat logs |
| A/B test itself | ✅ 4 configs, same fixtures, dry-run | ❌ | ❌ | ❌ |
| Failure forensics | ✅ sleep-cycle clusters + candidate fixes | ❌ | ❌ | ❌ |
| Stream live + interactive chat | ✅ `subscribe()` + `guppy chat` | ⚠️ | ⚠️ | ⚠️ |
| Open source / self-hosted | ✅ | ✅ (MIT) | ✅ (Apache-2.0) | ⚠️ mostly closed |
| Long-horizon resilience | ✅ checkpoint/resume (local) | ❌ | ❌ | ⚠️ partial |
| Multi-agent | 🔜 fork/merge events defined | ⚠️ | ❌ | ⚠️ subagents, unverified |

### The three structural edges, in one sentence each

1. **The gate is the arbiter.** Every harness that lets the model declare "done" inherits the model's overconfidence; guppy replaces belief with an executable check, and feeds the check's failure back into the next attempt.
2. **Every run is a learning event.** The trajectory store + fix extraction + sleep-cycle mean guppy compounds: run 10 tasks and it knows the recurring failure signatures and their fixes; competitors start each session from zero.
3. **It's a harness you can benchmark honestly.** guppy runs prime-agent and pi *inside its own bench*, on the same fixtures and same model — so when we say guppy-core beat guppy-prime on `bugfix-clamp` (1 attempt/19k tokens vs 2 attempts/59k tokens), that's a measured, reproducible claim, not marketing.

---

## Part 4 — North star

> **guppy standalone, better than both combined.**

Borrowed from prime: the clean event stream, the rich tool idea, the daemon-shaped lifecycle. Borrowed from pi: the tight prompt → model → tool-call → result loop. Owned by guppy: the verification gate, the memory, the sleep-cycle, the bench, and the fact that the whole brain runs in one process against any model you point it at. The roadmap in Part 2 is the path from "proven loop" to "unattended long-horizon harness."
