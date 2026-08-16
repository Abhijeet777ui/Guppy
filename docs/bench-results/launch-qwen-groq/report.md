# Guppy Bench Report

- Generated: 2026-08-16T18:43:39.215Z
- Model: qwen/qwen3.6-27b
- Configs: guppy-core
- Max attempts per task: 3
- Retries (guppy-core): 2 (base 500ms, max 30000ms)
- Dry run: no

## Summary

| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |
|---|---|---|---|---|---|
| guppy-core | 11/20 | 55% | 174575 | 1m37s | 46 |

- guppy-core vs prime-raw: pass rate +55pp, token ratio -x
- guppy-core tokens saved (ContextOps, est.): 933

## Per-task matrix

| Task | guppy-core |
|---|---|
| bugfix-clamp | PASS (2a, 21579 tok) |
| bugfix-sum | PASS (1a, 12948 tok) |
| bugfix-average | PASS (1a, 12698 tok) |
| bugfix-median | PASS (1a, 12677 tok) |
| bugfix-roundto | PASS (1a, 14736 tok) |
| bugfix-slugify | PASS (1a, 15497 tok) |
| bugfix-truncate | FAIL (1a, 0 tok) |
| bugfix-is-palindrome | PASS (1a, 15337 tok) |
| bugfix-groupby | PASS (1a, 12978 tok) |
| bugfix-chunk | PASS (1a, 16034 tok) |
| testadd-math-utils | PASS (1a, 10934 tok) |
| testadd-median-roundto | PASS (1a, 8505 tok) |
| testadd-string-utils | FAIL (2a, 16334 tok) |
| testadd-palindrome-capitalize | FAIL (2a, 2236 tok) |
| testadd-collections | FAIL (2a, 2082 tok) |
| refactor-rename-clamp | FAIL (1a, 0 tok) |
| refactor-rename-average | FAIL (1a, 0 tok) |
| refactor-rename-slugify | FAIL (1a, 0 tok) |
| refactor-rename-groupby | FAIL (1a, 0 tok) |
| refactor-rename-pluck | FAIL (1a, 0 tok) |

## Context health & token savings (ContextOps)

| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| guppy-core | 70 | 77.6 | WARN | 929 | 933 |

> Scored by [contextops@0.1.0](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).

## Failures

- **guppy-core / bugfix-truncate**: Model returned HTTP 400 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"tool call validation failed: parameters for tool run_command did not match schema: errors: [`/command`: expected array, but got string]","type":"invalid_request_error","code":"tool_use_failed","failed_gen
- **guppy-core / testadd-string-utils**: Model returned HTTP 429 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01ks402h65fgqt15d6sqdbrk2a` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 195834, Requested 4485. Please try aga
- **guppy-core / testadd-palindrome-capitalize**: Model returned HTTP 429 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01ks402h65fgqt15d6sqdbrk2a` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 197784, Requested 3173. Please try aga
- **guppy-core / testadd-collections**: Model returned HTTP 429 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01ks402h65fgqt15d6sqdbrk2a` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199512, Requested 3642. Please try aga
- **guppy-core / refactor-rename-clamp**: Model returned HTTP 429 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01ks402h65fgqt15d6sqdbrk2a` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199372, Requested 2763. Please try aga
- **guppy-core / refactor-rename-average**: Model returned HTTP 429 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01ks402h65fgqt15d6sqdbrk2a` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199230, Requested 2757. Please try aga
- **guppy-core / refactor-rename-slugify**: Model returned HTTP 429 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01ks402h65fgqt15d6sqdbrk2a` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199089, Requested 2761. Please try aga
- **guppy-core / refactor-rename-groupby**: Model returned HTTP 429 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01ks402h65fgqt15d6sqdbrk2a` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 198948, Requested 2759. Please try aga
- **guppy-core / refactor-rename-pluck**: Model returned HTTP 429 (https://api.groq.com/openai/v1/chat/completions): {"error":{"message":"Rate limit reached for model `qwen/qwen3.6-27b` in organization `org_01ks402h65fgqt15d6sqdbrk2a` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 198807, Requested 2759. Please try aga
