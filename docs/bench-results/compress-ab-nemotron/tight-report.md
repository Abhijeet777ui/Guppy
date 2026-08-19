# Guppy Bench Report

- Generated: 2026-08-19T11:20:17.533Z
- Model: nvidia/nemotron-3-super-120b-a12b:free
- Configs: guppy-core
- Max attempts per task: 1
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 1/1 | 100% | 203017 | 20.3s | 5 |

- guppy-core vs prime-raw: pass rate +100pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 0

## Per-task matrix

| Task | guppy-core |
|---|---|
| longhorizon-ledger | PASS (1a, 203017 tok) |

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 6 | 64.7 | WARN | 42 | 0 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).
