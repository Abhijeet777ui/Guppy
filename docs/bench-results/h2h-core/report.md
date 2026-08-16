# Guppy Bench Report

- Generated: 2026-08-15T20:06:00.291Z
- Model: nvidia/nemotron-3-super-120b-a12b:free
- Configs: guppy-core
- Max attempts per task: 2
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 0/1 | 0% | 0 | 2.9s | 0 |

- guppy-core vs prime-raw: pass rate +0pp, token ratio -x

## Per-task matrix

| Task | guppy-core |
|---|---|
| bugfix-sum | FAIL (2a, 0 tok) |

## Failures

- **guppy-core / bugfix-sum**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (1.8905ms) ✔ uniqueBy keeps the first item per key (0.3129ms) ✔ chunk splits arrays into groups (0.3178ms) ✔ pluck extracts a field from every item (0.1983ms) ✔ clamp keeps values inside the range (1.0473ms) ✖ sum adds all values (1
