# Guppy UX Spec — "convenient, obvious, beautiful"

**Status:** LOCKED — §14 decisions signed off 2026-08-17; M1–M3 implement against this.
**Branch:** `feature/nexus` · **Date:** 2026-08-17
**Implements:** `docs/ROADMAP.md` Track B (M1–M3) + Track C blockers.

This document is the contract for the `guppy chat` experience. M1–M3 are
scoped against it; every acceptance criterion in §15 is testable — either
headlessly (rendered via `@xterm/headless`) or by a visual sign-off on a real
terminal.

---

## 1. North star

> **Guppy should feel like talking to a very good engineer who is also
> transparent about what they're doing — not like watching a task runner.**

Three consequences of that sentence, which drive every decision below:

1. **The conversation is the interface.** The user types a request; Guppy
   replies in prose (with code, lists, tables) like a person would. A turn is
   *not* a "task summary" — it is a message with a reply.
2. **The work-in-progress is calm and legible.** While Guppy works, the user
   sees *what it is doing right now* in one glance ("Running npm test…"),
   never a wall of raw JSON or flickering logs.
3. **The first minute is frictionless.** A person with no API key and no idea
   what a "provider" is reaches a working chat in under a minute, guided the
   whole way.

---

## 2. Principles (how we decide)

| # | Principle | Meaning |
|---|---|---|
| P1 | **Reply first, telemetry second.** The assistant's answer is the hero; duration/tokens/tool counts are a dim footer, hidden by default. |
| P2 | **One calm status, always visible.** Exactly one place shows live activity; it never duplicates the transcript and never prints raw events (that's `/verbose`). |
| P3 | **Progressive disclosure.** First-run user sees the minimum (type, Enter, reply). Power user reaches the rest through `/help`, slash commands, and flags — nothing is removed, only organized. |
| P4 | **Every dead end is a door.** Any error (no key, unknown model, missing Docker, bad flag) tells the user the exact next action, in one line, with the command spelled out. |
| P5 | **Restraint is the beauty.** Limited palette, generous whitespace, consistent borders, no spurious color. "Beautiful" = calm + hierarchy, not chalk confetti. |
| P6 | **Reuse, don't rewrite.** Build on pi-tui's `Markdown`, `SettingsList`, `SelectList`, `Editor`, `Loader`. Add only the thin Guppy-specific layer. |

---

## 3. Visual design system

### 3.1 Theme

Detect the terminal's light/dark scheme (pi-tui exposes
`parseTerminalColorSchemeReport`). Default to the detected scheme; allow a
manual override (`/theme dark|light|auto`). All colors below are **roles**,
resolved per scheme — never hard-coded ANSI numbers scattered through code.

| Role | Dark | Light | Use |
|---|---|---|---|
| `text` | default fg | default fg | body copy |
| `dim` | gray | gray | meta, hints, footers, borders |
| `accent` | cyan | blue | the **Guppy** wordmark, active selection |
| `you` | cyan (bold name) | blue (bold name) | user message header |
| `guppy` | green (bold name) | green (bold name) | assistant message header |
| `ok` | green | green | done checkmark, passing gate |
| `warn` | yellow | yellow | retries, partial outcomes |
| `err` | red | red | failures, model errors |

Only these eight roles are allowed in the chat screen. The rainbow of per-event
colors stays confined to `/verbose`.

### 3.2 Type & spacing

- **Message rhythm:** one blank line between messages; message content is never
  run together with the next message.
- **Headers:** `You` / `Guppy` are the only bold labels in the transcript.
  Everything else inherits the body weight.
- **Code blocks:** indent by 2, surrounded by a dim border, with the language in
  a dim header line when known. Inline code is `dim` on a subtle inverse/reverse
  cell so it reads as a token.
- **Padding:** 1 column of horizontal padding inside the transcript; 2 for code
  blocks and quotes.

### 3.3 Borders

One border vocabulary, used everywhere:

- Panels and code blocks: single-line box-drawing (`─│┌┐└┘`), `dim`.
- The input dock: a full-width top rule (`─`) separating it from the transcript,
  never a full box (boxes around inputs look heavy).
- Selected picker row: `accent` prefix (`› `), not a filled bar (filling every
  row is visually loud on most terminals).

---

## 4. Layout anatomy

The chat screen has four persistent regions (top → bottom):

```
┌ context bar ─────────────────────────────────────────┐  1 line, dim
├ transcript (scrollable, grows) ──────────────────────┤  You / Guppy messages
│        …plus the activity line, inline, while working │
├ input dock ──────────────────────────────────────────┤  multi-line Editor
│ hint line                                              │  1 line, dim
└───────────────────────────────────────────────────────┘
```

| Region | Contents | Purpose |
|---|---|---|
| **Context bar** (top) | `repo · model · mode · verify · saved ≈N` | persistent answer to "where am I / with what?", plus cumulative token savings |
| **Transcript** (middle) | conversation; activity line while busy | the interface |
| **Input dock** (bottom) | `Editor` + slash autocomplete | typing |
| **Hint line** (bottom) | `Enter send · Shift+Enter newline · / for commands` | discoverability |

The **activity line** is not a separate always-on region — it appears *inside*
the transcript (below the last message) only while a turn is in flight, and is
replaced by the reply when the turn lands. This keeps "what's happening" where
the eye already is, and keeps the idle screen clean.

---

## 5. Screens & wireframes

### S0 — First-run onboarding (no key configured)

Shown when `guppy chat` or `guppy run` starts with no usable API key and no
explicit `--model`/`--provider`. This replaces today's dead
`claude-3-5-sonnet` fallback (Track C).

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│        ╭─────────╮                                  │
│        │  Guppy  │   your agent, on your repo       │
│        ╰─────────╯                                  │
│                                                     │
│  Guppy runs a verify → fix → verify loop on your    │
│  code. It needs a model to think with.              │
│                                                     │
│    ›  1. Groq           free tier (qwen · llama)    │
│       2. OpenRouter     free tier (many models)     │
│       3. Google Gemini  free tier                   │
│       4. Ollama         local, no key needed        │
│       5. I have a key for another provider          │
│                                                     │
│   ↑↓ choose   Enter select   Ctrl+C quit            │
└─────────────────────────────────────────────────────┘
```

After selecting a provider:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   Groq needs an API key (free — groq.com/console).  │
│                                                     │
│   API key: ••••••••••••••••••                       │
│                                                     │
│   Default model: › qwen3.6-27b      free · fast     │
│                  llama-3.3-70b      free            │
│                                                     │
│   The key is stored in ~/.guppy/config.json         │
│   (0600 permissions, masked everywhere).            │
│                                                     │
│   Enter continue                                    │
└─────────────────────────────────────────────────────┘
```

Rules:

- Key input is masked and never echoed into the transcript.
- The **recommended free model is pre-selected**, so Enter-through works.
- The choice persists to `~/.guppy/config.json` and becomes the session default.
- A "skip, use local Ollama" path is one selection away (option 4).
- On completion, drop into S1 with a one-line welcome.

### S1 — Chat screen, idle

```
┌─────────────────────────────────────────────────────┐
│  my-project · groq/qwen3.6-27b · build · v3 · saved ≈12.4k │
├─────────────────────────────────────────────────────┤
│  Guppy  Hello! I'm working on `my-project`.         │
│         Type a task — e.g. "fix the failing         │
│         test in src/parser" — or / for commands.    │
│                                                     │
├─────────────────────────────────────────────────────┤
│  › _                                                 │
│  Enter send · Shift+Enter newline · / commands · /help│
└─────────────────────────────────────────────────────┘
```

### S2 — Chat screen, working

The turn in flight shows **one** activity line + a spinner, plus a live
substatus of the current action. Nothing else moves.

```
│  You    fix the failing test in src/parser          │
│                                                     │
│  ⠋ Running npm test…                                │
│                                                     │
│  (previous conversation stays put above)            │
│                                                     │
│  › _                                                 │
│  Esc interrupt · model groq/qwen3.6-27b working     │
└─────────────────────────────────────────────────────┘
```

Substatus labels are **humanized, not event names**:

| Event/state | Shown as |
|---|---|
| model generating | `Thinking…` |
| streaming | live streamed text (throttled), no spinner |
| `ToolCalled search` | `Searching "…"` |
| `ToolCalled read_file` | `Reading src/parser.ts` |
| `ToolCalled apply_patch` | `Applying patch to 2 files` |
| `ToolCalled run_command` | `Running npm test` |
| gate running | `Verifying (3/5: tests)…` |
| retry/backoff | `Model rate-limited — retrying in 4s` |
| attempt 2 after failure | `Gate red — retrying with failure context (2/3)` |

### S3 — Chat screen, reply landed

The activity line is **replaced** by the rendered markdown reply; a dim footer
carries the telemetry.

```
│  You    fix the failing test in src/parser          │
│                                                     │
│  Guppy  The test was failing because `parseInput`   │
│         returned `null` for empty strings. I        │
│         hardened it to return `[]`:                 │
│                                                     │
│           ```ts                                      │
│           export function parseInput(s: string) {    │
│             return s.trim() ? [s] : [];              │
│           }                                          │
│           ```                                        │
│                                                     │
│         Tests: 3 passed · 0 failed                   │
│                                                     │
│  ─── ✓ 12s · 5.2k tokens · 3/3 tests · saved ≈1.2k ── │
│                                                     │
│  › _                                                 │
│  Enter send · Shift+Enter newline · / commands       │
└─────────────────────────────────────────────────────┘
```

- The footer is dim and single-line; `✓`/`✗`/`~` summarize `success` /
  `failure` / `partial`.
- The footer's `saved ≈N` is the turn's ContextOps token-savings estimate
  (§8); omitted when scoring is unavailable.
- On failure, the footer turns `err` and the reply carries the error **and** a
  one-line next action ("retry with `/retry`, or lower the gate with
  `/verify 2`").

### S4 — Model picker overlay

`/model <partial>` opens a `SelectList` overlay (this is a refinement of the
existing picker):

```
│  ┌─ pick a model ────────────────────────────────┐  │
│  │  qwen                                             │
│  │  › groq/qwen3.6-27b      ctx 128k · free · fast  │
│  │    groq/qwen3.6-32b      ctx 128k · free         │
│  │    openrouter/qwen-max   ctx 128k · paid         │
│  │  ─ 3 matches ────────────────────────────────   │
│  │  ↑↓ choose · Enter select · Esc cancel            │
│  └───────────────────────────────────────────────────┘
```

- A `free` badge appears for free-tier models (the launch audience).
- Fuzzy type-ahead (already available via `fuzzyFilter`).
- Selection rebuilds the runtime in place and persists the default.

### S5 — Settings screen

`/settings` opens a `SettingsList` with submenus — the settings-style flow that
replaces ad-hoc `/setup <provider> <key>` typing:

```
│  ┌─ settings ────────────────────────────────────┐  │
│  │  model          groq/qwen3.6-27b    › pick      │
│  │  provider       groq                › pick      │
│  │  thinking       off                 cycle       │
│  │  verification   tests (3)           cycle       │
│  │  mode           build               › pick      │
│  │  theme          auto                cycle       │
│  │  ──────────────────────────────────────────    │
│  │  ↑↓ navigate · Enter edit · Esc back             │
│  └───────────────────────────────────────────────────┘
```

Each row: `Enter` opens a `SelectList` submenu (model/provider/mode) or cycles
values (thinking/verification/theme).

### S6 — Plan / build mode indicator

(Track A slice 4 — designed now so the context bar is future-proof.)

- Context bar shows `plan` or `build`.
- In `plan` mode the input hint changes to `planning only — no edits · /build to execute`.
- A plan is rendered as a markdown reply with a **plan gate** footer:
  `Plan ready — /build to execute, or edit me`.
- The approval is a single `/build` (or a Y/n confirm overlay), never a raw
  `approve?` text prompt.

### S7 — Help overlay

`/help` (and `?`) opens a two-section help: **Everyday** and **Advanced**.
Every command in §9 is reachable from here; each row is one line.

```
│  ┌─ help ────────────────────────────────────────┐  │
│  │  Everyday                                      │
│  │  /help        this screen                      │
│  │  /model       pick the model                   │
│  │  /models      list/search models               │
│  │  /provider    pick the provider                │
│  │  /setup       add an API key                   │
│  │  /plan /build  plan first, then execute        │
│  │  /verify      set test strictness              │
│  │  /clear       clear the transcript             │
│  │  /exit        leave chat                       │
│  │  ──────────────────────────────────────────    │
│  │  Advanced                                      │
│  │  /thinking /verbose /status /retry /memory     │
│  │  Esc back                                      │
│  └───────────────────────────────────────────────────┘
```

---

## 6. Activity & status state machine

One turn passes through exactly these states; the activity line and context bar
derive from it. This is the single source of truth for "what's happening".

```
idle ──user sends──▶ thinking ──▶ working ──▶ verifying ──▶ done ──▶ idle
                        │           │            │            │
                        │           │            └────────────┼──▶ retrying ─▶ working
                        └───────────┴─────────────▶ error ────┴──▶ idle
```

| State | Context bar | Activity line |
|---|---|---|
| `idle` | `… · ready` | none |
| `thinking` | `… · working` | `⠋ Thinking…` or streamed text |
| `working` | `… · working` | spinner + humanized tool action |
| `verifying` | `… · working` | `Verifying (level/total: name)…` |
| `retrying` | `… · working` | `Model rate-limited — retrying in Ns` |
| `done` | `… · ready` | reply + dim footer |
| `error` | `… · ready` | `err` reply + one-line next action |

Implementation note: states map onto `EventStore.subscribe()` events
(`ModelCalled`, `ToolCalled`, `ToolReturned`, `Lint/Test` gate events,
`TrajectoryCompleted`) — the same single funnel the live stream already uses.
No new plumbing; this is a renderer change.

---

## 7. Assistant reply rendering spec (Track C)

This is the highest-value change. Today the runtime **discards** the model's
final text (`completion.content` when no tool calls remain). We will:

1. Add `finalAnswer: string` (and a `FinalAnswer`/`ModelReplied` event) to the
   contracts + core runtime, recording `completion.content` when the loop
   finishes with no tool calls.
2. Thread it into `ChatTurnResult` and both front-ends.
3. Render it with pi-tui's `Markdown` component using the §3 theme.

Markdown support (pi-tui `Markdown` already provides all of it):

- headings (levels 1–4), bold/italic/strike/underline
- fenced code blocks with language label + border
- inline code, blockquotes, horizontal rules
- ordered/unordered lists with nesting
- **tables** with width-aware wrapping
- links as OSC-8 hyperlinks (`hyperlink()`)
- LaTeX math → Unicode (default on)

If the model returns no prose (a pure tool run), fall back to the
`✓ N/M tests · Ds` footer so a bare success is still readable.

---

## 8. Token-savings metric (ContextOps)

Guppy surfaces **how many tokens the context engine is estimated to save**,
both per-turn and as a running session total. **Money is deliberately never
shown** — no `$`, no cost column, no price math. Tokens are the currency of
context; a dollar figure would turn a "is my context lean?" signal into a
billing readout.

**Data source.** ContextOps scores the exact captured payload
(`{ model, messages, tools }` that was about to hit the model) and reports
`estimated_reduction_pct`; Guppy computes
`tokensSaved = round(total_tokens × reduction_pct / 100)` per capture and
sums captures. This is the same bridge the bench already ships
(`@guppy/bench-runner` `context-health.ts`); the UX work is wiring it into
`run`/`chat` (Track C) and accumulating a session total.

**Where it appears.**

1. **Context bar** — a persistent, cumulative session total:
   `… · verify 3 · saved ≈12.4k`
2. **Per-turn footer** — that turn's savings:
   `✓ 12s · 5.2k tokens · 3/3 tests · saved ≈1.2k`
3. **`/status`** — the breakdown: captures scored, session total, and the
   `contextops@x.y.z` attribution. The main UI stays clean; provenance lives
   here and in `/verbose`.

**Formatting.**

- Compact via `compactTokens()`: `1.2k`, `12.4k`, `1.1M`.
- Always prefixed `≈` — it is an **estimate**, never a hard fact.
- Never money. No `$`, no per-model pricing, no "you saved $X".
- When ContextOps is unavailable (no Python / not installed / no captures),
  the metric is **omitted**, never a fake zero. `/status` says
  "ContextOps not available" with the install hint.

**Honesty rule.** The figure is "estimated tokens reclaimable from
ContextOps' findings," not "tokens the model didn't actually spend." The `≈`
marker and the `/status` attribution carry that caveat; the UI never relabels
it as realized savings.

## 9. Command inventory

### 9.1 Everyday (first-run `/help`)

| Command | Args | Behavior |
|---|---|---|
| `/help`, `?` | — | help overlay (§S7) |
| `/model [query]` | partial id | picker overlay; no arg → browse |
| `/models [query]` | search | list/search, with free/paid badge |
| `/provider [id]` | id | list, or set the active provider |
| `/setup [provider] [key]` | — | open settings; with args, store key |
| `/plan` | — | enter plan mode (Slice 4) |
| `/build` | — | execute the approved plan |
| `/verify <0-6>` | level | set gate strictness (6 = repo-declared invariant gate) |
| `/clear` | — | clear the transcript (not the session) |
| `/exit`, `/quit` | — | leave chat |

### 9.2 Advanced (power-user)

| Command | Args | Behavior |
|---|---|---|
| `/thinking [level]` | off\|minimal\|low\|medium\|high\|xhigh\|max | reasoning level |
| `/verbose` | — | toggle raw event stream |
| `/status` | — | session/model/gate/token diagnostics |
| `/retry` | — | re-run the last turn with failure context |
| `/memory` | — | show memories distilled this session (future) |
| `/theme` | dark\|light\|auto | override scheme |
| `/settings` | — | full settings screen |

Every command has autocomplete from the `Editor` slash provider; `/model` and
`/provider` get argument completions from the live catalog.

---

## 10. Flag inventory (the 80/20)

### New-user surface (shown in `--help` top and the onboarding)

```
guppy chat                # start chatting in the current repo
guppy run "<task>"        # run one task, non-interactive
  --model <id>            # e.g. groq/qwen3.6-27b
  --provider <id>         # groq | openrouter | google | ollama | …
  --local                 # run without Docker
  --resume                # continue the last interrupted run
  --thinking <level>      # reasoning effort
  --verify <0-6>          # gate strictness (6 = repo-declared invariant gate)
```

### Power-user surface (collapsed under a "more" section)

`--max-turns`, `--no-stream`, `--temperature`, `--max-tokens`,
`--model-timeout-ms`, `--max-retries`, `--retry-base-delay`,
`--retry-max-delay`, `--runtime`, `--wsl`, `--prime-binary`,
`--keep-worktree`, `--commit-message`, `--no-commit`, `--force`, `--quiet`,
`--tui/--no-tui`.

The `--help` text groups these under **Everyday** vs **Advanced** headings, so
the first screen a new user sees is ~7 flags, not ~30.

---

## 11. Keybinding map

| Keys | Context | Action |
|---|---|---|
| `Enter` | input | send / run command |
| `Shift+Enter` | input | newline (multi-line message) |
| `↑`/`↓` | input | history; in picker, move selection |
| `Tab` | input | complete (slash command / file / model) |
| `Ctrl+C` | idle | exit |
| `Ctrl+C` | picker open | dismiss the picker |
| `Ctrl+C` | busy | **interrupt** the current turn (confirm-first) |
| `Esc` | any overlay | close overlay |
| `Ctrl+L` | chat | clear screen (repaint) |
| `Ctrl+R` | input | search history (future) |

---

## 12. Discoverability & error rules

1. **No-key detection** → onboarding (§S0), never a dead model.
2. **Unknown model** → "No model `x` — did you mean one of: …" (top 3 fuzzy
   matches), or `/models` to browse.
3. **Unknown provider** → list core-compatible providers in the same message.
4. **Docker missing / image unbuilt** → `Docker isn't running — use --local to
   run on the host, or start Docker Desktop.` (already largely done; keep it).
5. **`-v 6`** → `Level 6 (formal verification) isn't supported yet — max is 5.`
   (already done; keep it).
6. **Model error (429/5xx/network)** → activity line says `retrying in Ns`; on
   final failure the reply names the cause ("rate limited after 3 tries"), not
   "tests failed" (the AUDIT-INSIGHTS silent-failure lesson, now a UX rule).
7. **Every command is reachable from `/help`;** `/help` is reachable from the
   hint line, `?`, and `guppy help`.

---

## 13. Implementation map

### Track C blockers — ✅ done (2026-08-17)

| Item | Where | Change | Status |
|---|---|---|---|
| Expose final answer | `@guppy/contracts`, `@guppy/core` `runtime.ts` | add `finalAnswer` + `FinalAnswer` event; record `completion.content` | ✅ |
| No-key detection | `@guppy/models` + `control-plane` preflight | `hasAnyApiKey(config)`; redirect to `guppy setup` | ✅ |
| Test hygiene | `control-plane` vitest config | exclude `**/.guppy/**` + `**/worktrees/**` from discovery | ✅ |
| ContextOps savings in UX | `@guppy/core` + `control-plane` | capture context per turn, score with ContextOps, accumulate `tokensSaved` into a session total; expose on the turn result | ✅ |

### M1 — the core experience

| Piece | pi-tui building block |
|---|---|
| Headless render harness | `@xterm/headless` (port the `VirtualTerminal` pattern already in `../prime-agent/packages/tui/test`) |
| Reply rendering | `Markdown` + §3 `MarkdownTheme` |
| Context bar | `Text` (top of `VStack`) |
| Activity line + spinner | `Loader` (or `CancellableLoader` for interruptible) |
| Input | `Editor` (already wired) + hint line |
| Live substatus | map `subscribe()` events → §6 labels |

### M2 — selection & onboarding

| Piece | pi-tui building block | Status |
|---|---|---|
| Onboarding wizard | `SelectList` steps over a `Box` overlay | ✅ `pickers.ts` `runSetupWizard` |
| Model/provider picker | `SelectList` (refined with free/paid badge) | ✅ `pickProvider` / `pickModel`; models fetched **live** from the provider's `/models` endpoint |
| Settings screen | `SettingsList` + submenus | deferred to M3 |
| Key input | `Input` (masked) or `Editor` + masked rendering | ✅ `Input` |

### M3 — polish

Theme detection, interrupt semantics, exit-screen dump, plan/build stubs in the
context bar, final look pass.

---

## 14. Decisions (locked)

Signed off 2026-08-17. Each is a one-way door for M1–M3; revisit only with a
new UX-spec change.

| # | Decision | Chosen | Note |
|---|---|---|---|
| D1 | Status layout | Top context bar + inline activity | §4 anatomy |
| D2 | Ctrl+C mid-turn | Interrupt the whole turn → "cancelled" | needs `AbortController` in the core client (test-first) |
| D3 | Telemetry footer | Always show the dim one-line summary | raw events stay behind `/verbose` |
| D4 | Assistant message shape | `Guppy` header + indented markdown | §7 |
| D5 | Theme | Auto-detect; `/theme` override deferred to M3 | role palette from the start |
| D6 | Token-savings figure | Session total + per-turn footer, `≈` estimate | money never shown (user-locked) |

---

## 15. Acceptance criteria (the definition of "done" for the UX track)

**M1** — mostly done (2026-08-17); visual sign-off pending
- [x] Headless harness boots the real TUI against a virtual terminal (in-memory
      `FakeTerminal`; `@xterm/headless` is an optional later upgrade), feeds
      keystrokes, asserts the rendered screen.
- [x] A chat turn renders a real markdown assistant reply, not a task summary.
- [x] While busy, exactly one activity line shows a spinner + humanized action.
- [x] The context bar shows a cumulative `saved ≈N` and the per-turn footer
      shows that turn's savings — tokens only, never money — omitted when
      ContextOps is unavailable.
- [ ] Visual sign-off on a real terminal (`pnpm cli -- chat`).

**M2** — done (2026-08-17)
- [x] No key ⇒ `guppy chat` on a TTY runs the setup wizard inline (provider →
      key → live model list) → straight into chat with the chosen default.
- [x] Provider → model picker flow works with ↑/↓ (no typing model ids); the
      model list comes from the provider's real `/models` endpoint, falling
      back to the catalog; free-tier (`:free`) entries sort first.
- [x] Fresh setup with a Groq key completes and persists
      (`~/.guppy/config.json` default); verified via the headless picker
      harness (5 tests) with a mocked live fetch.
- [ ] (deferred to M3) Type-ahead filtering + free/paid badges in the picker.

**M3** — done (2026-08-17), visual sign-off pending
- [x] Ctrl+C mid-turn aborts the whole turn (`AbortController` through the
      core client) → outcome `'cancelled'`, partial work discarded, turn
      footer marks the interruption; verified headlessly (core abort e2e +
      TUI interrupt harness).
- [x] Theme auto-detects dark/light at boot with a `/theme` override;
      context bar, markdown, and pickers all follow the role palette.
- [x] Exit prints a session stats dump (turns · tokens · tool calls · saved).
- [x] Plan/build modes: the context-bar indicator is now live behavior — `/plan`
      runs read-only planning turns (plan-gate footer: `Plan ready — /build to
      execute`), `/build` approves and executes the plan (Slice 4).
- [ ] Visual sign-off on a real terminal (`pnpm cli -- chat`).
