# Ultimate Guppy Roadmap

> **Supersedes** the forward-looking half of `docs/ROADMAP.md` (that file stays as the
> shipped-work record). **Companion:** `docs/CAPABILITIES.md` (what exists),
> `docs/STATUS.md` (what shipped and when), `plans/guppy-consolidated-plan.md`
> (decision log + ADRs). This document is the *destination* and the *route*.

## The seven pillars (non-negotiable)

Every phase below either amplifies one of these or it doesn't get built:

1. **The gate is the arbiter** — proven, never claimed.
2. **Event-sourced** — replayable, observable, queryable.
3. **Compounding** — memory / skills / sleep-cycle, benchmark-gated.
4. **Evidence over vibes** — the bench A/B is how we argue.
5. **Guppy owns the loop** — in-process, no borrowed runtime.
6. **Solo-scale** — git + SQLite + Docker. No Firecracker, K8s, vector DBs, GPU training.
7. **Deterministic-first** — hermetic, offline, testable.

**Explicitly out of scope (researched and rejected):** MCTS / beam search, Firecracker
microVMs, Kuzu/LanceDB vector memory, a 7B critic, multi-modal ingestion, browser /
computer-use / TTS / messaging-platform toolsets, and cron-style background agents.
Those are a personal-assistant or a GPU-lab product; Guppy is a *verified engineering
harness* for a solo developer.

---

## The end state (what "ultimate Guppy" looks like)

You hand it a multi-hour task on a **real, large, foreign-language repo**, walk away, and
come back to one of:

- a **proven-green result** — the full 0→6 ladder passed (typecheck → lint → tests →
  property → integration → *formal invariant*), merged back into your repo, or
- an **evidence trail** — the event log shows exactly where and why it stalled, and the
  log is *provably complete* (every byte the model ever saw is reconstructable from it).

While it works, it is:

- **Structured-context** — it reasons over a *repo map* (a codebase tree, not grep hits),
  injects only *bounded, typed, capped* context fragments, and keeps prompts cache-aligned.
- **Guarded** — a declarative tool-policy layer (deny / allow / ask-user) sits between the
  model and every action; the model never self-polices.
- **Collaborating** — it fans out to parallel subagents, auto-triggers a reviewer agent
  gated by the verifier, and merges conflicts back under the gate.
- **Checkpointable** — any turn can be restored and diffed, git-native.
- **Self-improving** — the sleep-cycle distills recurring fixes into skills *automatically*,
  and every change is promoted only when the bench proves it.
- **Efficient** — programmatic tool calls collapse N round-trips into one, and a tiered
  router spends cheap models on summarization/indexing and frontier models on synthesis.

And all of it still runs on a laptop.

---

## Phase 0 — Finish what is already pending (do this first, in this order)

| # | Item | Why it's first | Exit condition |
|---|---|---|---|
| 0.1 | **Commit the current tree.** Subagents, prime/pi removal, configurable ladder, `guppy gc`, install-fallback hardening, memory confidence weighting — all built, tested (319 tests / 13 packages), all **uncommitted**. | The roadmap builds on this; nothing else is real until it's on `main`. | `main` has the tree; clean `git status`. |
| 0.2 | ✅ **`CoreAgentRuntime.resume()`** — was the one `not implemented yet` stub in the engine. | Resume is pillar 2's *recovery* half; a stubbed resume is a lie until it runs. | **Done.** Runtime resume reconstructs the model-visible conversation from the event log and continues from the last complete turn; wired into `resumeTask`; e2e-proven (322 tests). |
| 0.3 | **Launch gate.** A clean 20-fixture free-tier run + one real live `run` and `chat` session, on a machine with Docker so the container e2e actually executes (it self-skips today). | The only remaining blocker in `LAUNCH_CHECKLIST`; the harness must be *proven*, not just green-on-fixtures. | 20/20 recorded + a real container-mode run. |
| 0.4 | ✅ **Visual sign-off** of the chat TUI (the last M3 acceptance). | The UX track is "done except the human said it looks good." | **Done (2026-08-21).** Headless screen dumps + a real-model Groq TUI session (fix landed, gate green) recorded at `docs/live/tui-signoff.md`; user approved the look — M1/M3 closed. |
| 0.5 | ✅ **Formal verification (level 6) — decide.** | It's a documented non-feature; leaving it ambiguous forever is the only wrong answer. | **Done (ADR-013, 2026-08-21).** Ladder top redefined as the **repo-declared invariant gate**: `-v 6` is accepted everywhere; a repo opts in via `guppy.json` `verification.levels.6`; when no invariant tool is configured the level is a skip-with-note (ADR-011), never a failure. Dafny stays in the deferred-forever locked decisions. |
| 0.6 | **Compression real numbers** — the deterministic-tight / LLM-summary rows that were quota-blocked (hermetic proof is done). | Pillar 4: the compression claim is currently hermetic-only. | **Done (2026-08-21).** Real-model A/B recorded at `docs/live/live-compression-ab.md`: deterministic vs LLM-summary rows both succeeded; long-horizon run on the full 47 KB ledger compressed 16× (avg −4,792 est tokens each, history bounded at ~25k). Findings: LLM summary is net-negative for small compressions (+2,100 tok for a 1-turn span); Groq free's 8k TPM caps payloads, OpenRouter free caps at 50 req/day — the quota wall is documented, not a mechanism gap. |

> Phase 0 is not "re-architect." It is *closing every open loop the harness already has*,
> so the roadmap below starts from a proven, committed baseline.

---

## Phase 1 — Make observability *structural* (the two foundation items)

**Adopt:** DeepSeek's **"model-visible ⟺ logged"** invariant + Codex's **bounded typed
context fragments**. These are one refactor: every fragment that reaches a model request
becomes a logged, capped, typed event; a gate test re-derives every request from the log.

- **Pillar:** 2 (event-sourcing) and 4 (evidence) — replay stops being "works" and becomes
  *provably complete*; ContextOps scoring becomes exact instead of estimated.
- **Exit gate:** a `replay-session` test that reconstructs each `ModelCalled` payload from
  events alone; zero untracked model-visible inputs.

## Phase 2 — Structured context (the capability unlock)

**Adopt:** aider's **repo map** (structural codebase tree) + Codex's **cache-aligned, no-history-rewrite** discipline + a **tiered model router** (cheap model for summarization/indexing, frontier for synthesis — the catalog already marks core-compatible models).

- **Why:** Guppy is green on 20-line hermetic fixtures and weak on real large repos — the
  exact gap the original architecture review flagged. The repo map is what makes
  "long-horizon on a real repo" (the stated end-state) actually work.
- **Pillar:** 1 (the gate finally runs against real code), 3 (context selection scales), 5.
- **Exit gate:** on a real foreign repo (Rust/Python), context selection beats flat-file
  keyword selection at ≥40% token reduction, measured by the bench.

## Phase 3 — Guardrails (the action-side gate)

**Adopt:** Antigravity's **declarative policy layer** (`deny` / `allow` / `ask_user` /
`enforce`) + Codex **approvals** + DeepSeek **lifecycle hooks** (`PreToolUse` /
`PostToolUse` / `Stop`, Claude Code/Codex-compatible). Generalize the existing `READ_ONLY_TOOL_NAMES` into Hermes-style **composable toolsets** (`coding`, `safe`, `hermetic`, `read-only`) selected per posture — subagents get `hermetic` by construction (replacing today's ad-hoc "drop MCP tools").

- **Pillar:** 1 extended to *actions* — the harness says what's allowed, the model doesn't
  self-police; 5 (declared tool surfaces).
- **Exit gate:** a policy that denies network/shell in a subagent is proven by a hostile-tool test (same pattern as the existing MCP hostile-server test).

## Phase 4 — Collaboration (finish what the subagent tool started)

**Adopt:** OpenHands **triggered microagents** + your own planned "reviewer agent gated by
the verifier" + **parallel fan-out** + **merge arbitration**. Subagents become: model-initiated *and* auto-triggered (a reviewer fires on every diff; an investigator fires on a red gate), runnable in parallel with isolated branches, with an arbitration step that resolves conflicts *under the gate*.

- **Pillar:** 1 (consensus never substitutes for a green test — the reviewer is gated too),
  3 (the reviewer's findings feed the sleep-cycle).
- **Exit gate:** on a task that breaks, a triggered reviewer catches a diff the model
  would have shipped; proven by a scripted-runtime e2e (the `loop-demo` pattern).

## Phase 5 — Checkpointing (time-travel)

**Adopt:** Cline's **checkpoint/restore + diff** (`restoreCheckpoint` /
`checkpointViewLatestChanges` / `checkpointLatestChangesCount`). Git-native per-attempt
checkpoints; restore to turn N, see what changed, branch from it.

- **Pillar:** 2 (recovery is a first-class verb, not a flag).
- **Exit gate:** restore-to-N and diff proven hermetically; `--resume` composes with it.

## Phase 6 — Efficiency (round-trip collapse)

**Adopt:** Hermes' **`execute_code`** — a sandboxed tool that runs a small script which
*calls other tools*, collapsing N model round-trips into one (effects still flow through
the same tool layer, so it stays gated).

- **Pillar:** 5 (efficiency without a borrowed loop), 6 (pure in-process win).
- **Exit gate:** a multi-step task measurably uses fewer model turns, with a guard that
  proves a runaway script is bounded (timeout + output cap).

## Phase 7 — Breadth (close the honest-limits list)

- SWE-bench loader: **cloning + building** (supply a URL, not a checkout).
- Level 6 formal gate (from 0.5) **or** the replaced top of the ladder, live against a
  real fixture.
- **Pillar:** 1 (the gate covers more languages and harder tasks), 4 (a real dataset).
- **Exit gate:** a SWE-bench instance runs end-to-end from URL to merged green result.

## Phase 8 — The compounding flywheel (why it improves week over week)

Close the loop the vision doc promised: sleep-cycle → **automatic skill distillation**
(recurring fixes become skills, not just memories) → **benchmark-gated promotion** (a
distilled skill only ships if the skill A/B proves it). Plus Hermes' **session-search**
(semantic recall of past sessions) as the memory layer's read path.

- **Pillar:** 3 — this is the "self-improving" half of the end-state, made systematic.
- **Exit gate:** a fix distilled in week N measurably improves week N+1's bench without
  a human authoring anything (the skill-demo pattern, automated).

---

## One-line route

> **Phase 0 close every open loop → Phase 1 log everything the model sees → Phase 2 let it
> see structure → Phase 3 guard what it does → Phase 4 let it collaborate → Phase 5 let it
> rewind → Phase 6 make it cheap → Phase 7 make it broad → Phase 8 make it improve itself.**

Every phase has a *measured* exit gate, because a roadmap without one is vibes — and
guppy's whole point is that vibes are what the verification gate exists to kill.
