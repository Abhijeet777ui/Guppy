# Guppy Bench Report

- Generated: 2026-08-16T12:59:32.369Z
- Model: gemini-2.5-flash
- Configs: guppy-core
- Max attempts per task: 2
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 2/2 | 100% | 27151 | 9.3s | 7 |

- guppy-core vs prime-raw: pass rate +100pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 76

## Per-task matrix

| Task | guppy-core |
|---|---|
| bugfix-clamp | PASS (1a, 11542 tok) |
| bugfix-sum | PASS (1a, 15609 tok) |

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 9 | 83.4 | WARN | 74 | 76 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).
