# Guppy Roadmap — the complete work list

**Branch:** `feature/nexus` · **Last updated:** 2026-08-17

This is the single source of truth for everything left to do: the original
prime/pi reuse slices **and** the new top-priority UX quality track, plus the
engine gaps found while doing UI work. Nothing here is forgotten; items get
checked off as they land.

**Current state:** 20/20 free-tier bench on `main`; on `feature/nexus` the
model catalog + thinking levels + per-user config/setup wizard + a rebuilt
TUI (pi-tui `Editor` + slash-command autocomplete) are shipped; full suite
**182 tests** green.

---

## Track A — Product layer (original prime/pi reuse slices)

| # | Item | Status |
|---|---|---|
| 0 | Foundation — `@guppy/models` package, pi-ai + pi-tui deps, NOTICE | ✅ done |
| 1 | Model catalog + `/models` + thinking passthrough | ✅ done |
| 1.5 | Per-user config + `guppy setup` wizard + `/setup` | ✅ done |
| 2 | **MCP** — `@guppy/mcp` connecting external tool servers, `guppy mcp add/list/remove` | ⏳ queued |
| 3 | **TUI interface** | 🔄 superseded by Track B (M1–M3) |
| 4 | **Plan / build modes** — plan phase + plan gate + approval | ⏳ queued |
| 5 | **Distributed skills** — `guppy skill install/list/remove` | ⏳ queued |
| 6 | Parity polish — cache-aware accounting, multimodal, provider presets | ⏳ optional |

---

## Track B — UX quality (new direction, TOP priority)

**Goal:** `guppy chat` feels like prime's `pi` / opencode — not just "an
interface", a *good* one. Each milestone ends in a headless-verified
screenshot (rendered via `@xterm/headless`) so the UI is checked **before**
the user sees it, plus a visual sign-off by the user on a real terminal.

### M1 — Chat screen (the core experience)
- [ ] `@xterm/headless` render harness — boot the real TUI against a virtual
      terminal, feed keystrokes, assert/export the rendered screen (so the
      build loop is no longer blind).
- [ ] Port prime's chat structure faithfully: multi-line `Editor` + slash
      menu, streaming activity pane, spinner/status line, proper exit.
- [ ] **Assistant reply** — capture the model's final text answer and render
      it as a markdown chat message, so chat is a real You/Guppy
      conversation, not just a task summary (needs a small `@guppy/core`
      change to expose the final message — Track C).
- [ ] Acceptance: headless screenshot + user runs `pnpm cli -- chat` and
      approves the look.

### M2 — Selection & onboarding
- [ ] Provider selector + model picker as a settings-style flow
      (provider-first: `/provider` → `/model`).
- [ ] **First-run onboarding** — no API key configured ⇒ launch drops into
      the guided setup (pick provider → paste key → default model) instead
      of a dead `claude-3-5-sonnet` fallback (Track C).
- [ ] Acceptance: fresh setup with a Groq key works end-to-end.

### M3 — Polish
- [ ] Theme/layout pass, Ctrl+C semantics, exit-screen dump, plan/build
      indicator stubs.
- [ ] Acceptance: final look approved.

---

## Track C — Engine gaps found during UI work

| Item | Why | Needed by |
|---|---|---|
| Expose the model's final text answer (core runtime) | Chat must show a real reply | M1 |
| First-run API-key detection in `run`/`chat` | No-key users hit a dead fallback model | M2 |
| Test hygiene: e2e leaves `.guppy/worktrees/` → vitest discovers duplicate test files | Leftover worktrees made the suite look red (4 bogus failures); teardown should clean up | anytime |

---

## Execution order

1. **M1** — headless harness + faithful chat screen + assistant reply
2. **M2** — selection + onboarding
3. **M3** — polish
4. **Slice 2 (MCP)** — external tools
5. **Slice 4 (plan/build)** + **Slice 5 (skills)**
6. **Slice 6** — parity polish, optional

Track C items are pulled in as dependencies of the milestone that needs them.
Every step lands on `feature/nexus` with tests green and `main` untouched.

---

## Next session — UX design + command/flag inventory (before M1 code)

A first-time user cannot be expected to know the slash commands or CLI flags.
Before building M1's UI, design the experience end-to-end and enumerate every
surface:

- **The first-run experience, step by step** — what a brand-new user sees and
  does from `pnpm cli -- chat` to their first successful task (no-key
  detection, guided setup, hints, welcome/help screens).
- **Complete command inventory** — every slash command (`/help`, `/models`,
  `/model`, `/provider`, `/thinking`, `/verify`, `/verbose`, `/setup`,
  `/exit`…) with purpose, arguments, and autocomplete behavior; decide which
  belong in the visible help vs. advanced.
- **Complete flag inventory** — every CLI flag on `run` / `chat` /
  `benchmark` / `models` / `config` / `setup` (`--model`, `--provider`,
  `--tui/--no-tui`, `--local`, `--keep-worktree`, `--no-commit`, `--force`,
  `--thinking`, `--verify`, `--rpm`, …) with defaults; find the 80/20 a new
  user needs vs. power-user.
- **Discoverability rules** — each command/flag must be reachable from the
  UI (help screen, `/` menu, hints) and each dead-end (e.g. no key, no
  exact model) must redirect to the fix.
- **Wireframes / flow** — sketch the chat screen, selection screen, and
  settings before coding.

Deliverable of the session: a short UX spec (`docs/UX-SPEC.md`) that M1–M3
implement against.
