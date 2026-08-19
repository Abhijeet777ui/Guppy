# Plan: Hybrid Context Compression (deterministic floor + optional LLM summary)

> **Status: IMPLEMENTED (2026-08-19).** Builds on the Slice-5.5 rolling recap. The
> real-model A/B (STATUS §6, bug #17) proved two concrete weaknesses: (1) the
> deterministic recap truncates every tool result to ~300 chars, so the model
> re-reads big files after compression — with the default keep-6 retention that
> cost **2× tokens**; (2) a one-line structural recap keeps *what happened* but
> loses *why / what's decided / what remains*, which is what LLM condensation
> in Claude Code / Cursor / OpenHands preserves.

## Goal

Make compression strictly better than both our previous deterministic recap
and the mainstream LLM-only approach, while keeping what we already have:
zero-cost, offline, deterministic, and measured.

## Design

### 1. Deterministic fix (always on, no model) — stop the re-reads
`buildRecap` keeps the **most recent tool result verbatim** (the loop already
caps it at 20k chars) instead of collapsing it to a 300-char first line.
Earlier tool results stay truncated. This retains the file content the model
just read, so it doesn't re-read after a recap.

### 2. Optional LLM summary (opt-in hybrid)
New `CoreRuntimeConfig.historySummarizer` (presence = enabled):
- After deterministic compression, call a summarizer model once with the
  *older* turns (capped transcript), asking for a compact recap that keeps
  decisions, findings, what was tried, what remains, and the latest file state.
- On success, replace the recap body with the LLM summary (header keeps
  `=== COMPRESSED HISTORY ===` for identity); on any failure — 429, network,
  no choices, abort — fall back to the deterministic recap unchanged.
- Summary tokens are counted into the trajectory's `tokensTotal`/`tokensByModel`
  (they are real spend) and reported on the `ContextCompressed` event as
  `summarySource: 'llm' | 'deterministic'` + `summaryTokens`.

Default stays deterministic (offline-safe, hermetic); LLM is opt-in via a
`--history-summary llm` flag on the bench + control-plane run/chat.

## Comparison methodology (honest, measured)

We can't run Claude Code / Cursor / OpenHands here, so the comparison is:
1. **Measured, self-controlled:** no-compress vs deterministic-recap vs
   LLM-summary on the same `longhorizon-ledger` fixture, same model — tokens
   (billed + payload) and ContextOps (CHS, wasted, per-payload FAILs).
2. **Absolute against the known field:** our deterministic recap is
   zero-cost/offline/deterministic (no competitor is); the LLM pass adds the
   semantic fidelity the mainstream harnesses have, but only when opted in,
   with the deterministic floor as a safety net they don't have.
3. **Quantified improvement** = delta over the previous deterministic A/B
   (203k billed / 42 wasted / 0 FAIL payloads) and over the no-compress
   baseline (288k / 82 wasted).

## Acceptance

- Unit: recap keeps the latest tool result verbatim (capped at `RECAP_LATEST_RESULT_CHARS = 4000`).
- E2E (scripted mock, branching on `tools` presence): LLM summary lands in the
  recap + event `summarySource:'llm'`; failed summarizer → deterministic
  fallback + `summarySource:'deterministic'`; summary tokens counted.
- Build + full suite green (**283 tests**, core 44).

## Results (2026-08-19)

- **Hermetic:** all green — capped-verbatim recap, LLM summary, and fallback
  all covered.
- **Real model (nemotron free):** the *no-compression* control run on
  `longhorizon-ledger` **FAILED** with **866,731 tokens / 167.8s / 14 tool
  calls**, ContextOps **386,597 wasted tokens** and a FAIL health score — the
  model re-read the 47k-char ledger until the context exploded and the gate
  stayed red. This is the failure compression exists to prevent.
- The deterministic-improved and LLM-summary runs were **quota-blocked** (the
  866k-token run consumed the account's last free requests; 429). Their real
  numbers land after the daily reset; the deterministic improvement is a
  strict upgrade over the prior measured −30% / 0-FAIL-payload run.
  Artifacts: `docs/bench-results/compress-ab-nemotron/`.
