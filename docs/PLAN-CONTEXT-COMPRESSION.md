# Plan: Context Compression for Long-Horizon Runs

> **Status: IMPLEMENTED (2026-08-19).** Rolling recap compression shipped in
> `@guppy/core` (deterministic, no LLM call), wired through run/chat/bench
> with a `--max-history-tokens` knob, a `ContextCompressed` event, and a
> compression counter on the trajectory. Verification: 280 tests green
> across 14 suites (core +8, control-plane +1).

## Problem

`CoreAgentRuntime.run`'s turn loop grows the message array unboundedly: every
model turn appends one assistant message plus one `tool` message per call,
each tool result truncated to 20k chars (~5k+ tokens). 30 turns × several
calls per turn = hundreds of thousands of tokens — the model window blows on
exactly the 1-hour tasks the harness exists for. The context engine's budget
covers the *system prompt*, not the *conversation history*.

## Design (deterministic-first, no LLM call)

A **rolling recap**: when the estimated history exceeds a budget, the older
turns are replaced by one compact `system` recap while the most recent turns
stay verbatim.

**`@guppy/core` — new `compress.ts` (pure, exported):**
- `estimateMessageTokens(messages)` — chars/4 heuristic over each message's
  content + tool-call JSON (tiktoken stays out of core; the repo's own
  fallback uses the same order of magnitude).
- `compressMessages(messages, { maxHistoryTokens, keepRecentTurns })`:
  - system prompt (index 0) is never touched; budget 0 disables.
  - under budget → unchanged; over budget → walk turns from the end, keep the
    last `keepRecentTurns` (default 2) model turns verbatim, and render the
    older ones as one `system` `=== COMPRESSED HISTORY ===` block: per turn
    the assistant's tool calls (name + truncated args) and each tool result
    (first ~300 chars), or a one-line text answer. The first user task message
    is kept as a `TASK:` line (it is redundant with the system prompt, which
    already embeds the task).

**`runtime.ts`:** config gains `maxHistoryTokens?` (default 60_000, 0 = off)
and `historyKeepRecentTurns?` (default 6). Before each model call, if history
is over budget, compress in place, emit a `ContextCompressed` event, and bump
`metrics.compressions`.

**Contracts:** `EventType` += `'ContextCompressed'` (payload: turnsCompressed,
messagesBefore/After, tokensBefore/After); `TrajectoryMetrics` += optional
`compressions`.

**Plumbing:** `--max-history-tokens <n>` on `guppy run`, `guppy chat`, and
both bench CLIs, threaded through `RuntimeOptions`/`BenchOptions` into
`createCoreRuntime`. Live-stream gains a `[compress]` render case.

## Tests

- `compress.test.ts` (pure): no-op under budget; compresses over budget;
  recent turns verbatim; recap contains tool names + truncated results;
  budget 0 disables; token estimator sanity.
- Core e2e: a scripted mock runs several turns with big `read_file` outputs
  at a low budget; asserts the model later receives a `COMPRESSED HISTORY`
  message, the event fires with correct counts, and `metrics.compressions`.
- Control-plane: live-stream renders `[compress]` (additive case).

## Non-goals (documented)

No LLM summarization yet (deterministic recap is the default and matches the
repo's "deterministic-first, pi-ai distillation later" ethos); cross-ATTEMPT
history is already reset by the session manager (fresh context per attempt).
