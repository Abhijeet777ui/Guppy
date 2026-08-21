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
The signature differentiator. After every attempt, guppy runs a **verification gate** (7 levels: syntax → typecheck → lint → unit tests → property tests → integration tests → formal verification) and only a green gate counts as success. The model never gets to declare victory. Levels 0-5 are exercised end-to-end; level 6 is the **repo-declared invariant gate** (ADR-013): a repo opts in via `guppy.json` `verification.levels.6` (dafny, a custom checker, …), and when no invariant tool is installed the level is a skip-with-note, never a failure (ADR-011).

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

- 2 configs: `guppy-core` (native) and `guppy-core-skill` (skills injected) — the active A/B pair. The prime/pi adapter configs were removed with `@guppy/agent-runtime` (dead weight: they needed an external prime-agent bundle or a third-party agent framework; the subagent tool now covers delegation natively).
- 20 fixtures across 3 kinds (10 bugfix, 5 testadd, 5 refactor).
- `--dry-run` materializes + gates without spending any tokens; `loop-demo` shows the closed loop with a scripted model; per-config model/provider flags.
- **Loud failures:** a model-client error (e.g. 429 after retries) fails attempt 1 with a clear red message — never a silent 0-token "failure."
- Head-to-head result (recorded before the adapters were retired): on the same model (nemotron 3 super 120b), **guppy-core fixed `bugfix-clamp` in one attempt (46s, 19k tokens, 5 tool calls) while prime-agent failed in 15 tool calls and 59k tokens.**
- **Free-tier validation (Phase 9, in progress):** 6/6 fixtures PASS in one attempt each on OpenRouter free (`nvidia/nemotron-3-super-120b-a12b:free`) covering all three kinds — bugfix, testadd, refactor (214,773 tokens, 45 tool calls); `bugfix-clamp` also PASS on Groq free (`llama-3.3-70b-versatile`); Gemini 2.5 Flash free passed a 2/2 smoke. A full **20-fixture** Gemini run scored 4/20, but most misses were silent 0-token model-client errors (now fixed) rather than agent outcomes — the loop is proven live on free tiers; a clean full-suite breadth number still needs a re-run.

### 1.8 Sleep cycle — offline, deterministic failure analysis
`guppy-bench sleep-cycle` clusters failures across all recorded sessions by normalized signature — pure counting, no LLM — and reports recurrence, whether each cluster was ever resolved, and the candidate files changed to fix it. It also re-distills memory so stale entries don't accumulate.

**Edge:** "which failures keep coming back, and what fixed them" is answered *for free* as a side effect of every run. No other harness answers this at all.

### 1.9 No borrowed runtimes (retired)
`@guppy/agent-runtime` (PrimeDaemonRuntime / PiAgentRuntime) was removed as dead weight: prime required an external `prime-agent` binary that isn't bundled (the CLI failed loudly for every user without it), pi wrapped a third-party agent framework, and the only consumers were the opt-in bench baselines — whose active A/B is core-vs-core-skill. What guppy borrowed — prime's **event-stream idea** and **RLM delegation**, pi's **tight prompt→tool loop** — is native now (`AgentForked`/`AgentMerged` events, the recursive `subagent` tool, the in-process core loop).

### 1.10 Worktree merge-back & context health (shipped)
Two launch-polish features on top of the loop:
- **Merge-back:** a successful run **commits + merges the agent's changes into your repo** (git mode) or mirrors the files (non-git), instead of destroying the worktree — the fix no longer silently vanishes. Tuned by `--keep-worktree`, `--commit-message <template>` (with `{task}`), and `--no-commit` (overlay files, no history). `--resume` merges back too.
- **Context health:** guppy bridges ContextOps' `estimated_reduction_pct` + installed version into a **`tokensSaved` metric** — surfaced in the bench report (a "Tokens saved (est.)" column, a per-config Summary line, and an attribution footer linking PyPI) plus the console `Done:` line, so ContextOps advertises itself through every guppy bench run.

---

## Part 2 — Future capabilities (roadmap)

### 2.1 ~~Checkpoint & resume~~ — ✅ shipped (local mode)
Checkpoint per attempt + `--resume` in the CLI, crash-safe long runs. Terminal success/exhaustion clears the checkpoint; a crash leaves it on disk. Container-mode resume is supported — the checkpoint persists the container id, and resume reaps the orphaned container before starting a fresh one bound to the same worktree. **Turn-level resume** picks up a hard-crashed attempt's *conversation* — `CoreAgentRuntime.resume()` reconstructs the exact model-visible message history from the event log and continues from the last complete turn.
**Why it matters:** long-horizon tasks that survive restarts. No competitor restores a mid-task trajectory; this makes guppy the harness you can leave running overnight.

### 2.2 ~~Live streaming & telemetry~~ — ✅ shipped
Streams the event stream to the terminal as it happens (tool calls, model turns, gate results) via `EventStore.subscribe()`. Default-on; `-q/--quiet` suppresses. Turns `guppy run` into a watchable, demoable process.

### 2.3 ~~Retry/backoff on model APIs~~ — ✅ shipped
Exponential backoff with jitter on 429/5xx/network, Retry-After aware, CLI-tunable. Unattended robustness.

### 2.4 ~~Richer tool set~~ — ✅ shipped
Native `search` (rg-backed with a substring fallback), diff-aware `apply_patch` (fuzzy context matching, path containment), `git_status`/`git_diff`. Keep prime's tool *richness* without its broken `ipython` liability.

### 2.5 ~~Skills~~ — ✅ shipped
Teach guppy repo/project-specific procedures (build rituals, test commands, conventions) via `<repo>/.guppy/skills/*.md` — front-matter `name`/`description`/`tags` plus a prompt body. `guppy skill add <name> <description>` authors them (`guppy skill list` to inspect); `loadSkills` reads the directory; the context engine's `selectSkills` picks the relevant ones per task (scored against task keywords and tags) and the runtime renders them into the system prompt's `=== SKILLS ===` section. The session manager and the bench runner both load them automatically.

### 2.6 Multi-agent: recursive subagents (fork/merge) — ✅ shipped
Prime's RLM idea, native to guppy. The core runtime exposes a `subagent` tool (`--no-subagents` to disable): the model can spawn a child agent on a fully self-contained sub-task, and the child gets **its own event-store trace** (a fresh child taskId + sessionId, queryable via `getTrajectory` and never polluting the parent's session), **its own turn budget** (default 6, per-call `max_turns` can only lower it), and **its own verification gate** — the same ladder the harness uses, run before anything is handed back. The child works in the shared workspace, so fold-back is physical; the tool result folds the evidence (outcome, budget usage, gate verdict, files changed) into the parent turn, and `AgentForked`/`AgentMerged` events (the contracts' original multi-agent events — now with producers) carry the gate outcome into the live stream. **The gate is the contract, not the child's self-report**: a red child gate returns as a tool ERROR the parent must fix or revert. Recursion is bounded: children carry the tool at depth-1 (default maxDepth 3), a runtime at the floor has no tool, and children are hermetic — no MCP/extra tools, no context engine, no streaming. Hermetic e2e tests prove child-trace isolation, the fold-back gate, red-gate errors, the depth cap (asserted on the actual tool payloads sent to the model), and the disabled case. Planned next: parallel fan-out, a reviewer agent gated by the verifier, and merge arbitration — all still under the harness's gate, so model consensus never substitutes for a green test.

### 2.7 Cross-repo memory
A shared memory store so fixes learned in one repo help in another (same library, similar pattern). The per-repo store is the seed; curation and namespacing come next.

### 2.8 Formal verification level 6 — ⚠️ unsupported
Dafny-backed verification (the only layer that could *prove* a property instead of testing it) has **no tooling set up**. The CLI rejects `-v 6` with a clear message instead of silently skipping the gate; `LEVEL_COMMANDS[6]` stays defined so wiring it later is a one-line change plus a Dafny fixture.

### 2.8b Verification breadth (levels 2/4/5) — ✅ shipped
Levels 2 (lint), 4 (property), and 5 (integration) were implemented but never executed — no repo had eslint, a property script, or an integration script, so the ladder always skipped them. Now wired + gated end-to-end: the workspace manager exposes the repo's node_modules inside the worktree (symlinked/junctioned from the source repo in local mode, bind-mounted in container mode — or installed into the workspace when the source repo has none), so tool levels resolve via `npx --no-install` (never from the registry, no host-path prefix that a container can't see) and `npm test` scripts resolve their runners. The install fallback is safe by construction: it runs inside the workspace (never the user's repo), adds `--package-lock=false` when the repo has no lockfile so a guppy run can never smuggle a `package-lock.json` into the merge commit (an existing lockfile is respected and the install stays pinned), and can be disabled entirely with `--no-install` on both `run` and `chat`. The eslint parser handles real stylish output (validated against eslint 9.39.5), lint gates emit `LintPassed`/`LintFailed` events, and dedicated fixtures prove each level gates: a lint violation stops the run until fixed, a property test catches in-range violations unit tests miss, and an integration test gates a module-boundary flow.

### 2.8c Per-project verification ladder (`guppy.json`) — ✅ shipped
Non-Node repos no longer need a Node toolchain to gate. A committed `<repo>/guppy.json` overrides the default commands per level — the worktree is the cwd and the command's tool is probed for availability (node_modules `.bin` first, then the system PATH), so pytest, cargo test, make test, or any binary can gate levels 3-5 (and 1-2 for language-specific checks):

```json
{
  "verification": {
    "levels": {
      "1": { "command": ["cargo", "check"] },
      "2": { "command": ["cargo", "clippy", "--", "-D", "warnings"] },
      "3": ["pytest", "-q"],
      "4": { "command": ["cargo", "test"] },
      "5": { "command": ["make", "test"] }
    }
  }
}
```

Each entry is a bare command array or `{ "command": [...], "alwaysAvailable": true }` (the latter skips availability probing — for repos that always ship the tool, e.g. a Makefile). A missing tool skips the level with a logged note, never fails the ladder. Levels not listed keep their defaults (`tsc`/`eslint`/`npm test`/…), and only configured levels probe the system PATH, so a machine's global tooling never changes behavior a repo didn't opt into.

### 2.9 Standard benchmarks — ✅ loader shipped; pytest gate pending
`guppy benchmark` now runs the hermetic 20-fixture suite (real report/JSON, `--dry-run`, A/B configs) and can load **SWE-bench-verified** and **LiveCodeBench JSONL datasets**: instances are materialized from a local checkout with the test patch applied (`--repo <checkout>`), and the gold patch is kept for validation. Remaining for a citable public score: a pytest-capable gate so real Python instances run end-to-end.

### 2.10 Context compression for long horizons
Progressive summarization of the trajectory mid-run so multi-hour tasks stay under the context budget — the "long-horizon" promise made real.

### 2.11 ~~Interactive mode~~ — ✅ shipped
`guppy chat`: a REPL over the same gate + memory + event-store loop, streamed live, with `/help`, `/verify <0-6>` (6 = repo-declared invariant gate, skipped when unconfigured), and `/exit`.

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
3. **It's a harness you can benchmark honestly.** the bench runs every config on the same fixtures and same model (the recorded core-vs-prime head-to-head on `bugfix-clamp` — 1 attempt/19k tokens vs 2 attempts/59k tokens — was measured, not marketing), and the skills A/B (`guppy-core` vs `guppy-core-skill`) stays fully reproducible.

---

## Part 4 — North star

> **guppy standalone, better than both combined.**

Borrowed from prime: the clean event stream, the rich tool idea, the daemon-shaped lifecycle. Borrowed from pi: the tight prompt → model → tool-call → result loop. Owned by guppy: the verification gate, the memory, the sleep-cycle, the bench, and the fact that the whole brain runs in one process against any model you point it at. The roadmap in Part 2 is the path from "proven loop" to "unattended long-horizon harness."
