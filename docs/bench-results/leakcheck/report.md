# Guppy Bench Report

- Generated: 2026-08-15T12:02:19.730Z
- Model: claude-3-5-sonnet
- Configs: prime-raw, guppy-prime
- Max attempts per task: 3
- Dry run: yes

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| prime-raw | 0/2 | 0% | 0 | - | 0 |
| guppy-prime | 0/2 | 0% | 0 | - | 0 |

- guppy-prime vs prime-raw: pass rate +0pp, token ratio -x

## Per-task matrix

| Task | prime-raw | guppy-prime |
|---|---|---|
| bugfix-clamp | FAIL (0a, 0 tok) | FAIL (0a, 0 tok) |
| testadd-math-utils | FAIL (0a, 0 tok) | FAIL (0a, 0 tok) |

## Failures

- **prime-raw / bugfix-clamp**: dry-run: fixture red as expected
- **prime-raw / testadd-math-utils**: dry-run: fixture red as expected
- **guppy-prime / bugfix-clamp**: dry-run: fixture red as expected
- **guppy-prime / testadd-math-utils**: dry-run: fixture red as expected
