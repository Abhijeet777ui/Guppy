# ContextOps per-payload scoring — context-compression A/B (nemotron-3-super-120b free)

Scored with contextops 0.3.3 (embedded in the bench's `analyzeContextCaptures` /
`analyzeCaptureFile` bridge). `longhorizon-ledger` fixture, 1 attempt each, all PASS.

## Aggregates (from each run's report)

| Run | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |
|---|---|---|---|---|---|
| base (no compression) | 7 | 68.4 | WARN | 82 | 96 |
| compressed (4k budget, default keep-6) | 13 | 61.0 | FAIL | 52,194 | 52,242 |
| tight (4k budget, keep-1) | 6 | 64.7 | WARN | 42 | 0 |

## Per payload

### base (7 payloads)
```
tok:32112 wasted:18 chs:70 ci:WARN
tok:32126 wasted:18 chs:70 ci:WARN
tok:32216 wasted:18 chs:71 ci:WARN
```
Uniformly healthy — history grows but stays structurally clean; no FAIL.

### compressed-default (13 payloads)
```
tok:22172 wasted:7   chs:63 ci:WARN
tok:23028 wasted:7   chs:64 ci:WARN
tok:39912 wasted:8693 chs:56 ci:FAIL
tok:39879 wasted:8687 chs:55 ci:FAIL
tok:39859 wasted:8684 chs:56 ci:FAIL
tok:23170 wasted:7   chs:65 ci:WARN
tok:23456 wasted:18  chs:63 ci:WARN
tok:23470 wasted:18  chs:64 ci:WARN
tok:23564 wasted:18  chs:64 ci:WARN
tok:32232 wasted:18  chs:71 ci:WARN
tok:40059 wasted:8675 chs:58 ci:FAIL
tok:39935 wasted:8681 chs:57 ci:FAIL
tok:39894 wasted:8681 chs:57 ci:FAIL
```
6 of 13 payloads FAIL with ~8.6k wasted tokens each — the recap's lossy tool
results made the model re-read the 47k-char ledger, stacking duplicate reads in
context. The structural root cause of the 2x token bill.

### tight (6 payloads)
```
tok:22172 wasted:7  chs:63 ci:WARN
tok:23022 wasted:7  chs:64 ci:WARN
tok:30855 wasted:7  chs:68 ci:WARN
tok:22271 wasted:7  chs:64 ci:WARN
tok:22558 wasted:7  chs:64 ci:WARN
tok:22597 wasted:7  chs:65 ci:WARN
```
Zero FAIL payloads, the lowest waste of all three runs (7/payload). CHS is a few
points under base (63–68 vs 70–71) because ContextOps scores the recap system
message itself as structural noise — the price of compression, distinct from
the re-read pathology above.
