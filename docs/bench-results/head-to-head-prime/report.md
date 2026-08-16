# Guppy Bench Report

- Generated: 2026-08-15T19:48:53.286Z
- Model: qwen2.5-coder:1.5b
- Configs: guppy-prime
- Max attempts per task: 2
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-prime | 0/2 | 0% | 0 | 2.8s | 0 |

- guppy-prime vs prime-raw: pass rate +0pp, token ratio -x

## Per-task matrix

| Task | guppy-prime |
|---|---|
| bugfix-clamp | FAIL (2a, 0 tok) |
| bugfix-sum | FAIL (2a, 0 tok) |

## Failures

- **guppy-prime / bugfix-clamp**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (1.3114ms) ✔ uniqueBy keeps the first item per key (0.2421ms) ✔ chunk splits arrays into groups (0.2101ms) ✔ pluck extracts a field from every item (0.1988ms) ✖ clamp keeps values inside the range (2.1669ms) ✔ sum adds all values (0
- **guppy-prime / bugfix-sum**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (2.5163ms) ✔ uniqueBy keeps the first item per key (0.4105ms) ✔ chunk splits arrays into groups (0.3486ms) ✔ pluck extracts a field from every item (0.3154ms) ✔ clamp keeps values inside the range (1.0244ms) ✖ sum adds all values (1
