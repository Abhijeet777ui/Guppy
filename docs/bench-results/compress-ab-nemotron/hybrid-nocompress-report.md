# Guppy Bench Report

- Generated: 2026-08-19T11:54:41.126Z
- Model: nvidia/nemotron-3-super-120b-a12b:free
- Configs: guppy-core
- Max attempts per task: 1
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 0/1 | 0% | 866731 | 2m48s | 14 |

- guppy-core vs prime-raw: pass rate +0pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 386544

## Per-task matrix

| Task | guppy-core |
|---|---|
| longhorizon-ledger | FAIL (1a, 866731 tok) |

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 15 | 62.5 | FAIL | 386597 | 386544 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).

## Failures

- **guppy-core / longhorizon-ledger**:   'test: '
