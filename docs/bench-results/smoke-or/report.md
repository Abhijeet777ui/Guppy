# Guppy Bench Report

- Generated: 2026-08-16T12:37:45.984Z
- Model: nvidia/nemotron-3-super-120b-a12b:free
- Configs: guppy-core
- Max attempts per task: 2
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 6/6 | 100% | 214773 | 45.1s | 45 |

- guppy-core vs prime-raw: pass rate +100pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 4627

## Per-task matrix

| Task | guppy-core |
|---|---|
| bugfix-clamp | PASS (1a, 38866 tok) |
| bugfix-sum | PASS (1a, 25545 tok) |
| bugfix-average | PASS (1a, 23848 tok) |
| testadd-math-utils | PASS (1a, 58074 tok) |
| testadd-collections | PASS (1a, 23504 tok) |
| refactor-rename-clamp | PASS (1a, 44936 tok) |

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 41 | 82.4 | WARN | 4624 | 4627 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).
