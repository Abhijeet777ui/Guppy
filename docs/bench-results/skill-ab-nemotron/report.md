# Guppy Bench Report

- Generated: 2026-08-19T10:27:58.459Z
- Model: nvidia/nemotron-3-super-120b-a12b:free
- Configs: guppy-core, guppy-core-skill
- Max attempts per task: 2
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 3/3 | 100% | 81549 | 32.9s | 19 |
| guppy-core-skill | 3/3 | 100% | 91443 | 24.3s | 20 |

- guppy-core vs prime-raw: pass rate +100pp, token ratio -x
- guppy-core-skill vs prime-raw: pass rate +100pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 580
- guppy-core-skill tokens saved (ContextOps, est.): 1089

## Per-task matrix

| Task | guppy-core | guppy-core-skill |
|---|---|---|
| bugfix-clamp | PASS (1a, 25223 tok) | PASS (1a, 25881 tok) |
| bugfix-sum | PASS (1a, 39557 tok) | PASS (1a, 38990 tok) |
| bugfix-average | PASS (1a, 16769 tok) | PASS (1a, 26572 tok) |

## Skill impact A/B (guppy-core vs guppy-core-skill)

| Task | No skills | Skills | Delta |
|---|---|---|---|
| bugfix-clamp | PASS | PASS | same |
| bugfix-sum | PASS | PASS | same |
| bugfix-average | PASS | PASS | same |

- Pass rate: 100% → 100% (+0pp)
- Tokens: 81549 → 91443 (+9894)
- Injected skills dir: C:\Users\ABHIJE~1\AppData\Local\Temp\tmp.4aL1fOyvbe\skills

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 22 | 83.4 | WARN | 579 | 580 |
| guppy-core-skill | 23 | 83.1 | WARN | 1085 | 1089 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).
