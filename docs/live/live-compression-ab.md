# Live recording: context-compression A/B (deterministic-tight vs LLM-summary)

- **Date:** 2026-08-21
- **Purpose:** close roadmap 0.6 (compression real numbers) with real-model runs
- **Fixture:** `longhorizon-ledger` bench fixture — a ledger module with `sumBalances` bugged (red: `test/ledger.test.ts` fails), git-initialized. Two sizes used:
  - **80-entry ledger (~3.4 KB)** for the Groq rows (fits Groq free's 8k TPM window)
  - **full 47 KB ledger** for the OpenRouter long-horizon row
- **Rows:** baseline (no compression) vs **deterministic recap** (`--history-summary none`) vs **LLM summary** (`--history-summary llm`), same budget (1000 est tokens)
- **Models:** `qwen/qwen3.6-27b` (Groq free) for the A/B rows; `cohere/north-mini-code:free` (OpenRouter free) for the long-horizon row
- **Outcomes:** A/B rows all **success** (fixture fixed, gate green, merged); long-horizon row ended **failure** on the OpenRouter free daily cap — itself a quota finding

## Numbers

| Row | Model | Calls | Est tokens sent | Compressions | History before → after (est) | Outcome |
|---|---|---|---|---|---|---|
| Baseline (no compression) | qwen3.6-27b (Groq) | 4 | 21,935 | 0 | — | success |
| **A: deterministic recap** | qwen3.6-27b (Groq) | 5 | 23,866 | 1 | 3,261 → 3,257 (−4) | success |
| **B: LLM summary** | qwen3.6-27b (Groq) | 5 | 23,806 | 1 | 3,235 → 3,438 (**+2100 summary tok**, net +203) | success |
| Long-horizon (full 47 KB ledger) | north-mini-code:free (OpenRouter) | 51 | ~1,570,170 | **16** | avg 24,272 → 19,480 (**avg −4,792 each**) | failure (free daily cap) |

## Findings

1. **Compression fires only when history grows.** On the 80-entry fixture the model fixed the bug in ~5 calls, so history peaked near the 1,000-token budget once — compression engaged a single time. The mechanism works, but the savings are negligible at short horizon.
2. **LLM summary is net-negative for small compressions.** Row B's summary of one turn cost **+2,100 tokens** while the raw turn it replaced was only ~3.2k — a net *increase* of ~200 tokens. Deterministic recap (Row A) costs ~4 tokens. LLM summarization only pays off when the compressed span is large.
3. **Long horizon is where compression earns its keep.** On the full 47 KB ledger, history grew past 24k est tokens and compression fired **16 times**, each bounding it back to ~19.5k — **avg 4,792 est tokens saved per compression**, ~77k total across the run. Without it the window would have blown Groq's 8k TPM long before.
4. **Quota reality (why 0.6 was blocked):**
   - **Groq free: 8k TPM.** The 47 KB ledger inflates the first request to 22–32k tokens → rejected outright. A 250-entry ledger (10 KB) also blew it (8,978 > 8,000). Only the ~80-entry fixture fit. TPM is a rolling window, so even two close requests (2,758 used + 5,483 requested) trip it.
   - **OpenRouter free: 50 requests/day.** The long-horizon run consumed the daily allowance mid-run (`X-RateLimit-Remaining: 0`, reset `1787356800000`) and died with a 429 — plus one provider-side 400 (Cohere rejected a malformed tool call). Full-fidelity long-horizon runs need credits or a BYOK provider.

## Transcript excerpts

Row A (deterministic, Groq) — compression line:

```
[CoreAgentRuntime] compressed 1 turn(s) of history (3261 -> 3257 est. tokens, deterministic)
[compress] 1 turn(s) (3261 -> 3257 est. tok)
[model] qwen/qwen3.6-27b (+6571/47 tok)
[done] success
  Outcome: success
```

Row B (LLM summary, Groq) — compression line:

```
[CoreAgentRuntime] compressed 1 turn(s) of history (3235 -> 3438 est. tokens, llm, +2100 summary tok)
[compress] 1 turn(s) (3235 -> 3438 est. tok)
[model] qwen/qwen3.6-27b (+6561/90 tok)
[done] success
  Outcome: success
```

Long-horizon (OpenRouter) — representative compression sequence:

```
[model] cohere/north-mini-code:free (+32211/203 tok)
[CoreAgentRuntime] compressed 4 turn(s) of history (24211 -> 19063 est. tokens, deterministic)
[model] cohere/north-mini-code:free (+32687/87 tok)
[CoreAgentRuntime] compressed 3 turn(s) of history (24746 -> 18527 est. tokens, deterministic)
[model] cohere/north-mini-code:free (+31555/438 tok)
...
[CoreAgentRuntime] compressed 8 turn(s) of history (24638 -> 18127 est. tokens, deterministic)
[done] partial
...
[CoreAgentRuntime] run failed: Model returned HTTP 429 ... "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"
```

## Artifacts

- Logs: `/tmp/ab-rowA.log`, `/tmp/ab-rowB.log`, `/tmp/ab-rowBase.log`, `/tmp/ab-orA.log`
- Driver scripts: `apps/control-plane/.scratch/run-ab-row.mjs`, `apps/control-plane/.scratch/materialize.mjs`, `apps/control-plane/.scratch/shrink-ledger.mjs`
- Verdict for roadmap 0.6: **done with real numbers** — the A/B rows succeeded and the long-horizon evidence shows compression bounding a 47 KB-payload run 16 times; remaining headroom is a quota/credits matter, not a mechanism gap.
