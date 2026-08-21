# Guppy — Launch Checklist

**Date:** August 16, 2026
**Purpose:** The single source of truth for everything that must be built, hardened, and tested before Guppy's first public launch. Phases are ordered by dependency; **only Phase 9 (real-model validation) remains a true launch gate** — Phase 7 (sandbox) is done, and the rest is capability breadth that improves usefulness but does not block a demo.

Each phase lists **What**, **Why**, **Work**, and **Testing / acceptance**. "✅" marks a completed phase.

---

## Phase 1 — Docs & hygiene ✅

**What:** Reconcile the roadmap docs with what actually shipped, write this checklist, and close the last test gap from the streaming/chat work.

**Work (done):**
- `docs/STATUS.md` — fixed stale/contradictory claims: retry (§5.3) and interactive mode (§5.9) marked done, event store corrected to **msgpack** (was "JSONL"), test counts updated (51 across 6 suites), §8 rewritten as this phase plan, §9 updated (Feel row, new merge-back + context-health rows), bug log extended (entries 8–11).
- `docs/CAPABILITIES.md` — Part 2 items 2.1/2.2/2.3/2.11 marked shipped; new §1.10 (merge-back + context health); Part 3 comparison table updated.
- `chat.test.ts` — added **mid-turn-exit regression tests** (the `/exit`-while-busy `ERR_USE_AFTER_CLOSE` crash and the piped-stdin-EOF stream-detach), driving the real `runChat` REPL through a scripted stream with a gate-controlled runtime.

**Testing:** control-plane suite green (chat tests now 4).

---

## Phase 2 — Model client hardening ✅

**What:** Model-request polish that matters on real 120b-class models.

**Work (done):**
1. `--temperature` and `--max-tokens` flags, threaded CLI → `buildAgentRuntime` → `ModelConfig` (both `run` and `chat`).
2. **Streaming (SSE) client** — `completeStream` parses SSE, accumulates text + tool-call fragments, and keeps the fenced-JSON fallback; the runtime emits throttled `ModelStreamed` events through the live stream. Default-on for the CLI (`--no-stream` disables); the bench stays non-streaming.
3. **Dirty-worktree guard for `--no-commit`** — `mergeBack` refuses to overlay onto a dirty git repo unless `--force`.
4. **Backoff regression test** — added the missing network-error case (429/Retry-After/5xx/4xx already covered).

**Testing:** core 14/14 (streaming content/tool-stitching/fenced-JSON fallback, network-error retry, streaming runtime e2e), control-plane 24/24 (dirty-guard refuse/force), bench-runner 12/12.

---

## Phase 3 — Tools ✅

**What:** Close the biggest real-world usefulness gap (4 tools today).

**Work (done):**
1. **Native `search` tool** — ripgrep-backed `search(query, path, glob)`, returns `path:line:match` lines, with a substring-scan fallback when rg isn't installed and a forward-slash-normalized output.
2. **Diff-aware `apply_patch`** — unified-diff application with fuzzy context matching (tolerates drifted line numbers), CRLF normalization, and one `FileChanged` per touched file. Plus `git_status`/`git_diff` tools for git worktrees.
3. Everything stays behind the `WorkspaceManager` path-containment choke point — search paths and patch paths that escape the worktree are rejected.

**Testing:** workspace 6/6 (patch parser + hunk applier incl. fuzzy match + conflict rejection), core 21/21 (search/apply_patch/git tools + path-escape rejection + multi-file patch), control-plane 24/24, bench-runner 12/12.

---

## Phase 4 — ~~Skills~~ ✅ done

**What:** Make the `skills` story real — today the loop hardcodes `skills: []`.

**Why:** The context engine's `selectSkills` exists but nothing produces skills, so the "teach guppy your repo's build rituals / test commands / conventions" promise is dead until then.

**Work (shipped):**
1. **Skills-directory loader** — `loadSkills` reads `<repo>/.guppy/skills/*.md` (front-matter `name`/`description`/`tags` + prompt body), skipping malformed files.
2. **Producer** — `guppy skill add <name> <description> [--tags a,b] [--prompt "…"]` writes a validated skill; `guppy skill list` inspects the repo's skills.
3. **Wiring** — SessionManager and the bench runner load skills and pass them into `selectContext`; the core runtime renders selected skills into the system prompt's `=== SKILLS ===` section (this last piece was the actual gap — the context carried them, the prompt dropped them).

**Testing (shipped):**
- Unit: context-engine 8/8 — loader (valid/malformed/missing/empty dirs), producer round-trip + validation, selection (skill packed when tags match, excluded when irrelevant).
- E2E: control-plane 2/2 — a fixture whose correct fix exists only in a skill: with the skill the mock (which refuses to guess) applies it and the real `npm test` gate passes; without it the run ends in outcome `failure`.

---

## Phase 5 — ~~Verification breadth~~ ✅ done

**What:** Honest coverage of the gate levels.

**Why:** Levels 2 (lint), 4 (property), and 5 (integration) are implemented but **never executed**; level 6 (Dafny) has no setup. Claiming a "7-level gate" while only 0/1/3 have ever run is the kind of edge a launch reviewer will catch.

**Work (shipped):**
1. **Wired levels 2/4/5 through `guppy run`** — the real fix was architectural: tool levels now resolve from the **source repo's** node_modules via `npm exec --prefix <repo> -- <tool>` and execute against the worktree. Worktrees deliberately carry no node_modules (copy strips it; git worktrees have only tracked files), so a bare `npx eslint`/`npx tsc` there either silently skipped (no local bin → skipped by the availability guard) or downloaded a fresh tool — a real product gap, not just a test gap.
2. **Fixed the eslint parser** — it expected `path:line:col` on one line, but real eslint 9's stylish reporter puts the file on its own header line with right-aligned rule ids. `parseLintErrors` now handles both, validated against captured eslint 9.39.5 output.
3. **Lint audit trail** — new `LintPassed`/`LintFailed` contract events (level 2 previously logged nothing), rendered in the live stream.
4. **Level 6 redefined as the repo-declared invariant gate (ADR-013)** — `-v 6` is accepted everywhere (run + chat + `/verify`); a repo opts in via `guppy.json` `verification.levels.6`, and when no invariant tool is configured the level is a skip-with-note (ADR-011), never a failure.

**Testing (shipped):**
- verification-engine 9/9 (new `parseLintErrors` suite against real eslint 9 output).
- control-plane 3/3 e2e — a lint-violation fixture (hermetic eslint-compatible shim emitting genuine stylish format), a property-test fixture (unit green, property red until the fix), and an integration-test fixture — each fails the gate until the correct fix, and each asserts its level's failure event landed in the store.
- Manual real-tool smoke: real `eslint@9.39.5` driven through the engine via `npm exec --prefix`, gate correctly red with per-file/line/rule errors against the worktree.
- CLI smoke: `-v 6` accepted (runs the repo-declared invariant gate, or skips-with-note when unconfigured); `-v 9` rejected; help shows `(0-6; 6 = repo-declared invariant gate…)`.

---

## Phase 6 — ~~Benchmark command~~ ✅ done

**What:** Resolve the misleading `guppy benchmark` stub.

**Why:** The control-plane CLI printed "Benchmark not yet implemented" while real benchmarking lives in `guppy-bench` — a confusing dead end at launch.

**Work (shipped):**
1. **`guppy benchmark` is real.** It runs the same bench harness `guppy-bench run` uses — the hermetic 20-fixture suite (`--tasks` to filter, `--config` for A/B, `--dry-run` to gate without an LLM) — and prints the same report/JSON/tokens-saved output. No more dead end.
2. **Standard dataset loading** (`@guppy/bench-runner` `datasets.ts`): `parseSweBenchJsonl` / `parseLiveCodeBenchJsonl` read the standard JSONL formats; `materializeDatasetInstance` copies a **local repo checkout** and applies the instance's `test_patch` on top, with the gold `patch` kept for validation. `guppy benchmark -s swe-bench --dataset <jsonl> --repo <checkout>` runs them through the full harness.
3. **Runner plumbing** — `BenchTaskSpec.fixtureDir` for pre-materialized fixtures; `BenchOptions.tasks` override so dataset tasks flow through `runBench` unchanged.
4. **Honest constraints documented** — materialization needs a local checkout at the right commit (no cloning/building), and the gate runs the repo's suite command, so real Python pytest SWE-bench/LiveCodeBench instances need a pytest-capable gate (future work). The loader is format-correct for both datasets today.

**Testing (shipped):**
- bench-runner 8/8 new: both JSONL parsers (valid/malformed/limit), materialize red→gold-green, `loadDataset` round-trip, and a dry-run `runBench` over a materialized dataset task through the real harness.
- CLI smokes: `guppy benchmark --dry-run` (builtin, real report) and `guppy benchmark -s swe-bench --dataset … --repo … --dry-run` (parses, materializes, gates red as expected).

---

## Phase 7 — ~~Sandbox (LAUNCH GATE)~~ ✅ done

**What:** Decide and validate the default execution mode.

**Why:** `guppy/executor:latest` is the **default**, but the image had never been built or run — every real run used `--local`.

**Work (shipped):**
1. **Image built + verified** — `docker build -t guppy/executor:latest docker/executor` (node 22.23, git, python3, make/g++, pnpm via corepack, non-root `guppy` user, `/workspace` bind mount).
2. **Fixed a real container-exec bug** — dockerode's `demuxStream` never emits 'end' on its PassThroughs for non-TTY execs, so every container `exec` hung forever. `readStream` now accumulates raw multiplexed bytes and splits the 8-byte frames itself; the exec timeout (previously ignored in container mode) is also honored — a timed-out exec rejects instead of hanging the gate.
3. **Container-mode e2e** — full gated run inside the container (seed bug red → host fix visible through the bind mount → gate green in the container → merge-back lands in the repo), and crash → checkpoint → **resume in container mode**: the checkpoint now persists the container id, `adoptWorkspace` reaps the orphaned container before starting a fresh one bound to the same worktree.
4. **Launch default: containers stay the default** (sandboxed execution is the product's differentiator), with a **loud, helpful probe**: `run`/`chat` call `probeContainerRuntime()` up front and exit with a clear "start Docker Desktop or use --local" message instead of an obscure dockerode error. `--local` remains the documented no-Docker path.

**Testing (shipped):**
- control-plane 2/2 container e2e (180s per-test timeouts; skipped when Docker is absent so plain CI stays green): container run + merge-back, crash/resume + orphan-reap assertion (the orphaned container id is verified gone via `docker ps`).
- Manual smokes: image contents (node/git/python/pnpm/non-root), container exec red→green against the bind mount, `docker ps` clean after destroy.

---

## Phase 8 — Learning breadth

**What:** Cross-repo memory + context compression.

**Why:** The stated purpose is "long-horizon + learns across runs," but memory is per-repo and there is no mid-run compression (unproven past ~8 min).

**Work:**
1. **Cross-repo memory** — a shared store with namespacing/curation so fixes learned in one repo help in another.
2. **Context compression** — progressive trajectory summarization to stay under the 100k budget on multi-hour tasks.

**Testing / acceptance:**
- E2E: a fix learned in repo A retrieves in repo B; a long scripted run stays under budget and still passes the gate.

---

## Phase 9 — Validation & launch (LAUNCH GATE)

**What:** Prove the loop on real models — **no paid frontier models required** — and ship. The launch target is a student/individual developer without API budget, so the validation story is "bring your own key, free tiers included."

**Work:**
1. **Free-tier / open-weight 20-fixture run** — run the full suite (10 bugfix + 5 testadd + 5 refactor) on whichever of these the user has access to, recorded in `results.json` + `report.md`. (A first full-suite attempt on Gemini 2.5 Flash free scored 4/20 — but 16 of the misses were silent 0-token model-client errors, since fixed, so it does not count as a breadth number. See STATUS §7 #13.)
   - **Google AI Studio key (free, no card)** → Gemini 2.5 Flash via the OpenAI-compat endpoint:
     `guppy-bench run --config guppy-core,guppy-prime --provider openai --base-url https://generativelanguage.googleapis.com/v1beta/openai --api-key $KEY --model gemini-2.5-flash`
   - **OpenRouter free tier (free signup)** → `nvidia/nemotron-3-super-120b-a12b:free` (**6/6 fixtures PASS in one attempt each, all three kinds — see `docs/bench-results/smoke-or/`**; 50 req/day cap — the full 20-fixture suite needs ~150 requests, so it must be split across days/providers or run on a paid tier).
   - **Groq free tier (free signup)** → `llama-3.3-70b-versatile` via `--base-url https://api.groq.com/openai/v1` (**`bugfix-clamp` PASS; 100k tokens/day cap — ~100k tokens per 6-fixture run, so a few fixtures/day at full depth**).
   - **Local open-weight** → a model big enough to code (qwen2.5-coder 7b/14b) via Ollama; the bundled 1.5b is too weak (0/2) and should not be the validation model.
2. **Real live `guppy run` + `guppy chat`** — streaming, merge-back, and chat have only been mock-verified; record one real session end-to-end (container mode is a nice-to-have here). The live-loop machinery is already proven on both OpenRouter and Groq free tiers.

> **Daily-cap reality (2026-08-16):** free tiers were exhausted in one validation day — Groq's 100k TPD after ~5 fixtures + replays, OpenRouter's 50 req/day after 6 fixtures (51 calls), and Gemini's free tier rate-limited mid-run (see STATUS §7 #13). The 20-fixture proof therefore spans several days on free tiers (split across providers/days), or one short paid run. Nothing about the loop is blocked — 6/6 live passes prove the pipeline; the 20-fixture run is breadth, not function.
3. **Cross-platform CI** — Linux + macOS + Windows-core (prime/pi baselines may stay Linux-only).
4. **Commit the tree** — most of the recent work is still uncommitted/untracked.
5. **Upgrade ContextOps to 0.3.4** locally — the report footer advertises the installed version, and the local env still resolves 0.3.3.

**Testing / acceptance:**
- The 20-fixture report on a free-tier/open-weight model is committed and citable (with the model + date recorded, exactly like a paid run would be); a real chat session is recorded; CI is green on all three platforms. A "validated on free/open-weight models" claim is honest and launchable — there is no requirement to spend money.

---

## Broken edges & risky features to watch (not all are ours)

| Edge | Owner | Mitigation |
|---|---|---|
| prime-agent hangs on custom Ollama providers | external | document; keep a hosted provider (OpenRouter free tier is fine) for the A/B baseline |
| prime-agent `ipython` tool breaks on Windows | external | don't rely on prime's rich tools; replace with our own (Phase 3) |
| OpenRouter free-tier 50 req/day cap | external | retry/backoff shipped; keep the run small or use Gemini Flash / Groq free tiers |
| EventStore `append()` backpressure (comment admits synchronous notify) | ours | bound listener work; assert no listener can break a run (already caught+logged) |
| `AgentForked`/`AgentMerged` defined but unused | ours | implement (multi-agent) or remove from docs before launch |
| ContextOps env (0.3.3 vs 0.3.4, import/pip disagree) | ours | `pip install -U contextops` |

## Cross-cutting testing matrix

| Layer | Coverage now | Needed before launch |
|---|---|---|
| Unit | core, agent-runtime, verification, sleep-cycle, control-plane (20), bench (12) | + backoff matrix, tool patch/search, skills loader (Phases 2–4) |
| E2E (mock) | full loop, resume, chat, merge-back, live stream | + streaming client, tools, skills (Phases 2–4) |
| E2E (real model) | 6/6 passes (nemotron free tier) + Gemini/Groq partial | clean 20-fixture suite on a free-tier/open-weight model (Phase 9) |
| Sandbox | container task/destroy/resume/merge, orphan reaping, probe | Phase 9 real-model run in the container |
| Cross-platform | Windows dev machine only | Linux + macOS + Windows-core CI (Phase 9) |
