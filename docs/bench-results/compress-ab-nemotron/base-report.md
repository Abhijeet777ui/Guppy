# Guppy Bench Report

- Generated: 2026-08-19T11:16:25.930Z
- Model: nvidia/nemotron-3-super-120b-a12b:free
- Configs: guppy-core
- Max attempts per task: 1
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 1/1 | 100% | 288496 | 30.1s | 6 |

- guppy-core vs prime-raw: pass rate +100pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 96

## Per-task matrix

| Task | guppy-core |
|---|---|
| longhorizon-ledger | PASS (1a, 288496 tok) |

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 7 | 68.4 | WARN | 82 | 96 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).
