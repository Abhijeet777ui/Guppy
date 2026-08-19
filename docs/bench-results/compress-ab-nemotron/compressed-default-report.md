# Guppy Bench Report

- Generated: 2026-08-19T11:17:46.133Z
- Model: nvidia/nemotron-3-super-120b-a12b:free
- Configs: guppy-core
- Max attempts per task: 1
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 1/1 | 100% | 578461 | 52.6s | 12 |

- guppy-core vs prime-raw: pass rate +100pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 52242

## Per-task matrix

| Task | guppy-core |
|---|---|
| longhorizon-ledger | PASS (1a, 578461 tok) |

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 13 | 61.0 | FAIL | 52194 | 52242 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).
