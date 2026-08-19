# Guppy Roadmap — the complete work list

**Branch:** `feature/nexus` · **Last updated:** 2026-08-17

This is the single source of truth for everything left to do: the original
prime/pi reuse slices **and** the new top-priority UX quality track, plus the
engine gaps found while doing UI work. Nothing here is forgotten; items get
checked off as they land.

**Current state:** 20/20 free-tier bench on `main`; on `feature/nexus` the
model catalog + thinking levels + per-user config/setup wizard + a rebuilt
TUI (pi-tui `Editor` + slash-command autocomplete) are shipped; plan/build
mode indicator stubs are in the context bar; a headless screen-dump harness
renders the real TUI's output into screen grids; full suite **270 tests**
green (Slice 5 distributed skills + cross-repo memory + the skill-impact
bench A/B and `guppy-bench skill-demo` shipped; see STATUS §0).

---

## Track A — Product layer (original prime/pi reuse slices)

| # | Item | Status |
|---|---|---|
| 0 | Foundation — `@guppy/models` package, pi-ai + pi-tui deps, NOTICE | ✅ done |
| 1 | Model catalog + `/models` + thinking passthrough | ✅ done |
| 1.5 | Per-user config + `guppy setup` wizard + `/setup` | ✅ done |
| 2 | **MCP** — `@guppy/mcp` connecting external tool servers, `guppy mcp add/list/remove` | ✅ done (Slice 2, 2026-08-18) |
| 3 | **TUI interface** | 🔄 superseded by Track B (M1–M3) |
| 4 | **Plan / build modes** — plan phase + plan gate + approval | ✅ done (Slice 4, 2026-08-18) |
| 5 | **Distributed skills** — `guppy skill install/list/remove` | ✅ done (Slice 5, 2026-08-19) |
| 6 | Parity polish — cache-aware accounting, multimodal, provider presets | ⏳ optional |

---

## Track B — UX quality (new direction, TOP priority)

**Goal:** `guppy chat` feels like prime's `pi` / opencode — not just "an
interface", a *good* one. Each milestone ends in a headless-verified
screenshot (rendered via `@xterm/headless`) so the UI is checked **before**
the user sees it, plus a visual sign-off by the user on a real terminal.

### M1 — Chat screen (the core experience)
- [x] Headless render harness — boot the real TUI against a virtual terminal
      (in-memory `FakeTerminal`, `@xterm/headless` optional later), feed
      keystrokes through the real editor input path, assert the rendered
      screen. First harness test green.
- [x] Faithful chat structure: multi-line `Editor` + slash menu, inline
      activity line (spinner + humanized action while busy), context bar,
      dim footer, proper exit. (Live streamed text in the activity line is
      deferred to M3 polish.)
- [x] **Assistant reply** — the model's final text answer is exposed
      (Track C) and rendered as a markdown chat message via pi-tui
      `Markdown`, so chat is a real You/Guppy conversation.
- [~] Acceptance: headless assertions green; **visual sign-off pending** —
      run `pnpm cli -- chat` and approve the look.

### M2 — Selection & onboarding
- [x] **Arrow-key provider + model pickers** (`apps/control-plane/src/pickers.ts`)
      — standalone pi-tui screens, no typing model ids from memory. The model
      list comes from the provider's **live `/models` endpoint** (Groq /
      OpenRouter / OpenAI / NVIDIA / Ollama / Gemini) via
      `fetchLiveModels` in `@guppy/models`; catalog fallback on failure, with
      free-tier (`:free`) entries sorted first.
- [x] **Setup wizard** — `guppy setup` on a TTY runs provider picker → key
      paste → live model picker, saving the key + default to
      `~/.guppy/config.json`. The non-TTY readline flow is kept for scripts.
- [x] **Launch-time picker** — `guppy chat` on a TTY with no explicit
      `--model/--provider/--api-key` and no configured default drops into the
      pickers first, then starts chat with the choice (persisted as the
      default for next launch). No-key users get the wizard inline instead of
      a dead-model error.
- [x] Acceptance: headless harness boots the real picker TUIs, arrow-selects
      live/catalog models, walks setup end-to-end (5 picker tests); fresh
      Groq-key setup verified via mocked live fetch.

### M3 — Polish
- [x] Ctrl+C mid-turn interrupts the whole turn via `AbortController` threaded
      through the core client (`CancelledError`, signal checks between
      turns/tools, no retry of cancelled requests) → outcome `'cancelled'`;
      SessionManager discards partial work; TUI renders a cancelled footer.
- [x] Theme: dark/light palettes (`palette()` in tui-logic), auto-detected at
      boot, `/theme light|dark` override, mode-aware context bar + markdown +
      select-list themes (6 new tests).
- [x] Exit-screen dump: session stats summary printed on shutdown.
- [x] Plan/build indicator stubs (context bar shows plan/build; /plan and /build
      flip it; plan mode refuses turns until Slice 4 ships the real plan phase).
      Headless screen dumps verify the layout; final look = user sign-off
      pending.

---

## Track C — Engine gaps found during UI work

All **done** (2026-08-17), plus the ContextOps token-savings wiring that UX
spec §8 depends on:

| Item | Why | Status |
|---|---|---|
| Expose the model's final text answer (core runtime) | Chat must show a real reply | ✅ done — `FinalAnswer` event + `Trajectory.finalAnswer` |
| First-run API-key detection in `run`/`chat` | No-key users hit a dead fallback model | ✅ done — `hasAnyApiKey` + preflight → `guppy setup` hint |
| Test hygiene: e2e leaves `.guppy/worktrees/` → vitest discovers duplicate test files | Leftover worktrees made the suite look red | ✅ done — vitest excludes `**/.guppy/**` + `**/worktrees/**` |
| ContextOps savings in `run`/`chat` | §8 wants a live `saved ≈N` figure | ✅ done — capture + incremental tracker |

---

## Execution order

1. **M1** — headless harness + faithful chat screen + assistant reply ✅
2. **M2** — selection + onboarding ✅
3. **M3** — polish ✅ (interrupt, theme, exit dump, plan/build indicator stubs; final look = user sign-off)
4. **Slice 2 (MCP)** — external tools ✅ (`@guppy/mcp` + `guppy mcp add/list/remove`)
5. **Slice 4 (plan/build)** ✅ — read-only plan phase (`sessionManager.plan` + a dedicated read-only core runtime), plan-gate footer, `/build` approval, `/edit` plan revision; `PlanProduced`/`PlanRevised`/`PlanApproved` events (the revision records a model-plan line diff)
6. **Slice 5 (skills)** ✅ — `@guppy/skills` + `guppy skill install <name|url|path> [--registry] [--force]`, `guppy skill remove <name>`, `guppy skill list` (user + repo origins); builtin registry (code-review, write-tests, commit-hygiene, refactor-rename); installs land in `~/.guppy/skills` so they follow the user across repos, and SessionManager merges them into every run/chat context (repo skills win collisions)
6. **Slice 6** — parity polish, optional

Track C items are pulled in as dependencies of the milestone that needs them.
Every step lands on `feature/nexus` with tests green and `main` untouched.

---

## Next session — M1 (chat screen)

UX spec is written and **locked**: `docs/UX-SPEC.md` (§14 decisions signed off
2026-08-17). Track C blockers are done. Next:

1. **M1** — ✅ faithful chat screen + real markdown reply (M1 acceptance done
   except the visual sign-off — run `pnpm cli -- chat` and approve the look).
2. **M2** — ✅ arrow-key provider/model pickers + setup wizard + launch picker.
3. **M3** — polish (interrupt, theme, exit-screen dump).

See `docs/UX-SPEC.md` §12–§15 for wireframes and acceptance criteria.
