# Guppy Bench Report

- Generated: 2026-08-15T20:05:06.717Z
- Model: nvidia/nemotron-3-super-120b-a12b:free
- Configs: guppy-prime
- Max attempts per task: 2
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-prime | 0/1 | 0% | 59034 | 1m53s | 15 |

- guppy-prime vs prime-raw: pass rate +0pp, token ratio -x

## Per-task matrix

| Task | guppy-prime |
|---|---|
| bugfix-clamp | FAIL (2a, 59034 tok) |

## Failures

- **guppy-prime / bugfix-clamp**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (5.1315ms) ✔ uniqueBy keeps the first item per key (0.4212ms) ✔ chunk splits arrays into groups (0.7511ms) ✔ pluck extracts a field from every item (0.577ms) ✖ clamp keeps values inside the range (3.3074ms) ✔ sum adds all values (0.
