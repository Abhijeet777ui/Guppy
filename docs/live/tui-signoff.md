# Live recording: `guppy chat` TUI visual sign-off (roadmap 0.4)

- **Date:** 2026-08-21
- **Goal:** the last M1/M3 acceptance — the chat TUI's *look* verified headlessly,
  then on a **real model**, so a human sign-off is an informed one.
- **Headless evidence:** `screen-demo.test.ts` boots the real TUI against a virtual
  terminal and dumps each checkpoint as an actual screen grid (the M1–M3
  "headless-verified screenshot" step).
- **Real-model evidence:** the same `runTui` driven headlessly with
  `groq/qwen/qwen3.6-27b` (key from `~/.guppy/config.json`) against a red
  `clamp` fixture; one real turn through the full gated loop.
- **Outcome:** boot screen clean; real turn landed `success` (2 tool calls,
  5k tokens, ~11s); gate escalated to level 3 and passed
  (`VerificationEscalated` → `TestPassed` in the event log); exit-screen dump
  printed. The script lives at `apps/control-plane/.scratch/tui-signoff.mjs`.

## 1. Headless screen dump (scripted runtime — the layout itself)

The five checkpoints the `screen-demo` harness renders (real TUI, virtual
terminal, mock runtime — this proves *rendering*, not the model):

```
--- 1. boot — build mode ---
+----------------------------------------------------------------------------------------------------+
|[Guppy] fixture · fake/chat · verify 3 · build                                                      |
|[Guppy] Chat mode — each message runs the full gated loop (verify → retry → memory).                |
|  Repo: …\fixture                                                               |
|  Model: fake/chat  Verification: 3  Max turns: 1                                                   |
|  Type / for commands, or just describe a task and press Enter.                                     |
|────────────────────────────────────────────────────────────────────────────────────────────────────|
|Enter send · Shift+Enter newline · / for commands                                                   |
+----------------------------------------------------------------------------------------------------+

--- 2. after a chat turn (reply + footer + saved) ---
|You: fix the clamp                                                                                  |
|✓ 1153ms · 250 tokens · 1 tool calls · 2/0 tests · saved ≈10                                        |
|Fixed the clamp. See src/math.ts.                                                                   |

--- 3. after /plan — indicator + hint swapped ---
|[Guppy] fixture · fake/chat · verify 3 · plan · saved ≈10                                           |
|Plan mode — messages are read-only planning turns (no edits). /build to approve and run.            |
|planning only — no edits · /build to execute                                                        |

--- 4. plan produced (read-only) — plan gate footer ---
|~ 103ms · 250 tokens · 1 tool calls · 0/0 tests · saved ≈0                                          |
|Read the file, then patch the clamp.                                                                |

--- 5. after /build — plan approved + executed ---
|Plan executed: patched the clamp.                                                                   |
|Enter send · Shift+Enter newline · / for commands                                                   |
```

## 2. Real-model TUI session (Groq, red fixture)

`node .scratch/tui-signoff.mjs` — same `runTui`, real engine, real key, one
turn: `fix the clamp so the tests pass`.

```
--- 1. boot — build mode (real Groq model) ---
|[Guppy] fixture · groq/qwen/qwen3.6-27b · verify 3 · build                                          |
|[Guppy] Chat mode — each message runs the full gated loop (verify → retry → memory).                |
|  Model: qwen/qwen3.6-27b  Verification: 3  Max turns: 6                                            |
|  Type / for commands, or just describe a task and press Enter.                                     |
|────────────────────────────────────────────────────────────────────────────────────────────────────|
|Enter send · Shift+Enter newline · / for commands                                                   |

--- 2. after a real chat turn (reply + footer) ---
|[Guppy] fixture · groq/qwen/qwen3.6-27b · verify 3 · build · saved ≈21                              |
|You: fix the clamp so the tests pass                                                                |
|✓ 10757ms · 5k tokens · 2 tool calls · 0/0 tests · saved ≈21                                        |
|All tests pass. The fix swapped Math.min and Math.max so that clamp correctly returns the input     |
|value bounded between min and max.                                                                  |
|────────────────────────────────────────────────────────────────────────────────────────────────────|
|Enter send · Shift+Enter newline · / for commands                                                   |
+----------------------------------------------------------------------------------------------------+
[Guppy] Session: 1 turn · 5k tokens · 2 tool calls · 0/0 tests · saved ≈21
[Guppy] Bye.
```

**Event-log proof the turn was a real gated run** (from the session's
`events/index.db`): `TaskStarted` → `ModelCalled`×3 → `ToolCalled`×2 →
`FileChanged` (the fix) → `VerificationEscalated` → `TestPassed` →
`FinalAnswer` → `TrajectoryCompleted` with `outcome: success`, 5,071 tokens,
2 tool calls, 18 events. The fixture's `.guppy/events` trail is the source of
truth; the screens are its face.

## What this closes

- **M1 acceptance** — faithful chat screen + real markdown reply: headless
  screens above show the structure (context bar, activity line, footer,
  plan/build modes); the real-model run shows it working with an actual
  model and gate.
- **M3 acceptance** — polish (interrupt, theme, exit-screen dump,
  plan/build indicator): the exit dump prints in the real run; `/theme` and
  Ctrl+C behavior are covered by the `chat.test.ts` TUI harness tests.

**Human step:** run `pnpm cli -- chat --repo <any repo> --model qwen/qwen3.6-27b --provider groq`
on a real terminal and confirm the look. Headless + real-model evidence above
is the review packet for that sign-off.
