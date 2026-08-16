# Guppy Bench Report

- Generated: 2026-08-16T13:03:18.135Z
- Model: gemini-2.5-flash
- Configs: guppy-core
- Max attempts per task: 2
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 4/20 | 20% | 33062 | 6.9s | 10 |

- guppy-core vs prime-raw: pass rate +20pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 338

## Per-task matrix

| Task | guppy-core |
|---|---|
| bugfix-clamp | PASS (1a, 4955 tok) |
| bugfix-sum | FAIL (2a, 0 tok) |
| bugfix-average | FAIL (2a, 0 tok) |
| bugfix-median | PASS (1a, 11925 tok) |
| bugfix-roundto | PASS (1a, 9586 tok) |
| bugfix-slugify | FAIL (2a, 0 tok) |
| bugfix-truncate | FAIL (2a, 0 tok) |
| bugfix-is-palindrome | FAIL (2a, 0 tok) |
| bugfix-groupby | FAIL (2a, 0 tok) |
| bugfix-chunk | FAIL (2a, 0 tok) |
| testadd-math-utils | FAIL (2a, 0 tok) |
| testadd-median-roundto | PASS (2a, 6596 tok) |
| testadd-string-utils | FAIL (2a, 0 tok) |
| testadd-palindrome-capitalize | FAIL (2a, 0 tok) |
| testadd-collections | FAIL (2a, 0 tok) |
| refactor-rename-clamp | FAIL (2a, 0 tok) |
| refactor-rename-average | FAIL (2a, 0 tok) |
| refactor-rename-slugify | FAIL (2a, 0 tok) |
| refactor-rename-groupby | FAIL (2a, 0 tok) |
| refactor-rename-pluck | FAIL (2a, 0 tok) |

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 47 | 71.8 | WARN | 340 | 338 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).

## Failures

- **guppy-core / bugfix-sum**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (3.5177ms) ✔ uniqueBy keeps the first item per key (0.7453ms) ✔ chunk splits arrays into groups (1.5158ms) ✔ pluck extracts a field from every item (0.5606ms) ✔ clamp keeps values inside the range (4.3025ms) ✖ sum adds all values (2
- **guppy-core / bugfix-average**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (4.8866ms) ✔ uniqueBy keeps the first item per key (0.4911ms) ✔ chunk splits arrays into groups (0.4315ms) ✔ pluck extracts a field from every item (0.3545ms) ✔ clamp keeps values inside the range (2.7453ms) ✔ sum adds all values (0
- **guppy-core / bugfix-slugify**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (3.6633ms) ✔ uniqueBy keeps the first item per key (0.394ms) ✔ chunk splits arrays into groups (0.3584ms) ✔ pluck extracts a field from every item (0.3007ms) ✔ clamp keeps values inside the range (1.519ms) ✔ sum adds all values (0.2
- **guppy-core / bugfix-truncate**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (1.9482ms) ✔ uniqueBy keeps the first item per key (0.2505ms) ✔ chunk splits arrays into groups (0.2579ms) ✔ pluck extracts a field from every item (0.1784ms) ✔ clamp keeps values inside the range (1.2524ms) ✔ sum adds all values (0
- **guppy-core / bugfix-is-palindrome**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (2.8916ms) ✔ uniqueBy keeps the first item per key (0.4523ms) ✔ chunk splits arrays into groups (0.3878ms) ✔ pluck extracts a field from every item (0.4288ms) ✔ clamp keeps values inside the range (1.5518ms) ✔ sum adds all values (0
- **guppy-core / bugfix-groupby**:  > test > node --test test/*.test.ts  ✖ groupBy groups items by key (3.5389ms) ✔ uniqueBy keeps the first item per key (0.3929ms) ✔ chunk splits arrays into groups (0.3228ms) ✔ pluck extracts a field from every item (0.2899ms) ✔ clamp keeps values inside the range (1.4765ms) ✔ sum adds all values (0
- **guppy-core / bugfix-chunk**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (5.2592ms) ✔ uniqueBy keeps the first item per key (0.6513ms) ✖ chunk splits arrays into groups (26.899ms) ✔ pluck extracts a field from every item (0.5299ms) ✔ clamp keeps values inside the range (3.1605ms) ✔ sum adds all values (0
- **guppy-core / testadd-math-utils**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (3.147ms) ✔ uniqueBy keeps the first item per key (0.4222ms) ✔ chunk splits arrays into groups (0.3737ms) ✔ pluck extracts a field from every item (0.4504ms) ✖ TODO: test suite not written yet (2.121ms) ✔ slugify converts text to ur
- **guppy-core / testadd-string-utils**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (2.461ms) ✔ uniqueBy keeps the first item per key (0.3689ms) ✔ chunk splits arrays into groups (0.3322ms) ✔ pluck extracts a field from every item (0.2852ms) ✔ clamp keeps values inside the range (1.3333ms) ✔ sum adds all values (0.
- **guppy-core / testadd-palindrome-capitalize**:  > test > node --test test/*.test.ts  ✔ groupBy groups items by key (3.3426ms) ✔ uniqueBy keeps the first item per key (0.4408ms) ✔ chunk splits arrays into groups (0.3672ms) ✔ pluck extracts a field from every item (0.5382ms) ✔ clamp keeps values inside the range (1.5271ms) ✔ sum adds all values (0
- **guppy-core / testadd-collections**:  > test > node --test test/*.test.ts  ✖ TODO: test suite not written yet (1.9184ms) ✔ clamp keeps values inside the range (1.3183ms) ✔ sum adds all values (0.4303ms) ✔ average computes the mean (0.7221ms) ✔ median finds the middle value (0.3753ms) ✔ roundTo rounds to decimal places (0.3621ms) ✔ slug
- **guppy-core / refactor-rename-clamp**:   'test: '
- **guppy-core / refactor-rename-average**:   'test: '
- **guppy-core / refactor-rename-slugify**:   'test: '
- **guppy-core / refactor-rename-groupby**:   'test: '
- **guppy-core / refactor-rename-pluck**:   'test: '
