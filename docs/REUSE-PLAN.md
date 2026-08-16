# Prime / Pi Reuse Plan — completing Guppy's interface

**Status:** plan · **Branch:** `feature/nexus` · **Date:** 2026-08-16

Guppy's core (loop, verification ladder, memory, sandbox, model client) is
launched and verified (20/20 free-tier bench, 139 tests, CI green). This plan
covers the **product layer** — interface, model selection, external tools,
modes, skills — by **reusing the prime-agent / pi-ai source we already have**
instead of reimplementing it.

---

## 1. Goal

Reach feature parity with opencode / Claude Code / prime-agent for the
**user-facing experience**, on top of Guppy's existing engine:

- A real TUI for `guppy chat` (panes, streaming, keybindings, slash commands).
- **"All models to choose from"** — a model catalog + `/models` picker + provider setup.
- **MCP** — connect external tool servers as agent tools.
- **Reasoning / thinking-level control** for reasoning models.
- **Plan mode / build mode** separation.
- **Distributed skills** (installable, not just repo-local).
- Prompt-cache + multimodal polish where cheap.

## 2. Guiding principles

1. **Reuse, don't rewrite.** Proven MIT code is available locally (`../prime-agent`) and on npm (`@earendil-works/*`). Reimplementing it is waste.
2. **Additive, not replacement.** Nothing gets taken away from the launched core. Every reuse lands behind a boundary (adapter / package), and `main` stays green the whole time.
3. **Depend on npm where it's stable, vendor where we must reshape.** `pi-ai` / `pi-tui` are published and versioned → depend. Skills + a couple of patterns are deeply coupled → vendor with MIT attribution.
4. **Keep the auditable core.** Guppy's thin OpenAI-compatible client stays the *primary* runtime path (free-tier, deterministic, testable). pi-ai is the **catalog + capability layer**, not a replacement client.
5. **Attribution.** All MIT sources keep their headers; a `NOTICE` file tracks vendored/dependency provenance. License compatibility: pi-ai/pi-tui/pi-coding-agent are **MIT** — fully compatible with Guppy's Apache-2.0.

## 3. Source inventory (verified against the tree)

| Package | License | What it is |
|---|---|---|
| `@earendil-works/pi-ai` (npm 0.84.2) | MIT | Full model library: generated model registry (`models.generated.ts`), `models.ts` registry API, providers (openai, anthropic, google/vertex, mistral, deepseek, xai, groq, openrouter, bedrock, azure, cloudflare, codex), thinking options per provider (`AnthropicThinkingDisplay`, `GoogleThinkingLevel`, …), MCP (catalog + OAuth), streaming, cache pricing, typebox schemas, `register-builtins`. |
| `@earendil-works/pi-tui` (npm 0.7.1) | MIT | Minimal TUI framework: `TUI`, `Input`, `Editor`, `Markdown`, `SelectList`, `SettingsList`, `Loader`, `Box`, `Container`, `Image`; differential rendering, CSI-2026 sync, bracketed paste, slash-command autocomplete, themes. |
| `@earendil-works/pi-coding-agent` | MIT | Agent CLI internals we mine selectively: built-in skills dir + config, background planning pass with review/approve statuses, `--autonomous-gate*` flags. |
| `prime-agent` (top-level) | — | Aggregator monorepo (agent/ai/coding-agent/tui). No license field; individual packages carry MIT. |

## 4. Reuse map (gap → source → mode → integration point)

| # | Guppy gap | Reuse from | Mode | Integration point |
|---|---|---|---|---|
| 4.1 | Model catalog + `/models` picker | `pi-ai` `models.ts` + `models.generated.ts` (cost/context/reasoning/cache/vision, 8+ providers) | npm dep | New `@guppy/models` package → feed `guppy chat` `/models` and config |
| 4.2 | Reasoning / thinking levels | `pi-ai` providers (`AnthropicThinkingDisplay`, `GoogleThinkingLevel`, `reasoning_effort`) | npm dep | Map to `ModelConfig` extras → pass through `OpenAIChatClient` (backward-compatible body fields) |
| 4.3 | MCP (external tools) | `pi-ai` `mcp/` (catalog, OAuth, `mcp:<server>` providers) | npm dep | New `@guppy/mcp` package: MCP server tools → `GuppyTool[]` bridge into the tool loop |
| 4.4 | TUI interface | `pi-tui` framework | npm dep | New `apps/guppy-tui` (or control-plane mode) wrapping SessionManager + `EventStore.subscribe` streaming |
| 4.5 | Provider presets + auth config | `pi-ai` `env-api-keys.ts`, `oauth.ts`, `api-registry.ts` | npm dep / adapt | `@guppy/models` config file (per-user `~/.guppy/config.json`) |
| 4.6 | Distributed skills | `pi-coding-agent` skills dir + config | vendor (MIT headers) | Extend context-engine `loadSkills` + `guppy skill` CLI (install/update/list) |
| 4.7 | Plan / build modes | `pi-coding-agent` planning pattern (concept, not code) | adapt | `guppy chat` `/mode` + `guppy run --plan`: research-only phase, plan gate, then act |
| 4.8 | Cache + multimodal polish | `pi-ai` `cache-pricing.ts`, model `image` input flags | npm dep (opt-in) | Token accounting + optional image message support in the client |

## 5. Architecture & integration design

```
apps/guppy-tui          pi-tui UI: chat panes, /models picker, settings, plan/build
        │ uses
@guppy/models           pi-ai catalog + provider presets + ModelConfig building
        │ uses
@guppy/mcp              pi-ai mcp client → GuppyTool[] bridge
        │
@guppy/core  ──(unchanged primary runtime)──  OpenAIChatClient + tools + loop
```

- **Boundary 1 — ModelConfig:** Guppy keeps its own `ModelConfig` (provider/model/baseUrl/apiKey/…). `@guppy/models` maps a selected catalog model → `ModelConfig` + optional thinking/cache fields. pi-ai types never leak into `@guppy/core`.
- **Boundary 2 — tools:** MCP servers expose tools; `@guppy/mcp` converts them to `GuppyTool` definitions and routes execution through `WorkspaceManager` (so sandbox/containment applies). Only enabled per-server via config.
- **Boundary 3 — UI:** `apps/guppy-tui` consumes the same `SessionManager` + `EventStore.subscribe()` stream the CLI already uses; the readline REPL stays as `--no-tui` fallback.
- **Boundary 4 — skills:** keep Guppy's `Skill` type + context injection; add install/update/distribution on top.

## 6. Work slices

Each slice is a reviewable unit on `feature/nexus` (sub-branches for large ones), with tests, and must keep the full suite green.

### Slice 0 — Foundation (0.5–1 day)
- Add `pi-ai` (pinned) + `pi-tui` deps to the workspace; add `NOTICE` with MIT provenance.
- Skeleton `@guppy/models` + `@guppy/mcp` packages (empty, wired into workspace, `--passWithNoTests` off — real tests from slice 1).
- Adapter smoke test: `pi-ai` registry loads, one catalog query returns metadata.

### Slice 1 — Model catalog + thinking levels (2–4 days)
- `@guppy/models`: query catalog by provider/family/capability; list models for `/models`; build `ModelConfig` from a selection (incl. `reasoningEffort`/`thinkingLevel`).
- `OpenAIChatClient`: pass through optional thinking fields (backward compatible; default unchanged).
- `guppy chat` `/models` + `/provider` commands (readline first; TUI in slice 3).
- Tests: catalog queries, config mapping, thinking-field passthrough.

### Slice 2 — MCP (3–5 days)
- `@guppy/mcp`: connect servers from config (`mcpServers`), list tools, convert to `GuppyTool[]`, execute through `WorkspaceManager`, respect containment.
- `guppy mcp add/list/remove` + config file.
- Tests: in-process mock MCP server → tool call → result (hermetic, like the existing tool tests).

### Slice 3 — TUI (4–7 days)
- `apps/guppy-tui` on `pi-tui`: chat pane (streaming via `EventStore.subscribe`), input line with slash autocomplete, `/models` `SelectList`, settings pane, plan/build indicator.
- `guppy chat --tui` (default when TTY); readline remains.
- Tests: component-level (renders events, handles keys) — headless where possible; manual TUI QA checklist.

### Slice 4 — Plan / build modes (2–3 days)
- `guppy run --plan` and `guppy chat` `/plan` `/build`: plan phase = research + write a plan (no src edits), plan gate (structure/coverage check), approval (TUI confirm), then build phase reuses the existing loop + verification ladder.
- Tests: plan phase cannot edit `src/`; plan → build handoff; gate semantics.

### Slice 5 — Distributed skills (2–3 days)
- `guppy skill install <pkg>` / `list` / `remove`; skills resolved from a registry dir + repo `.guppy/skills`; vendor the pi-coding-agent skills config pattern with MIT attribution.
- Context-engine: include installed skills in selection (existing path).
- Tests: install → available to context engine → injected.

### Slice 6 — Parity polish (2–4 days, optional)
- Provider setup wizard (add key → preset base URLs); cache-aware token accounting; image input if a model supports it; `--quiet`/scriptable flags so CI stays usable.

**Total:** ~2.5–4 weeks for one person, parallelizable (slices 4/5 after 3).

## 7. Deliberately NOT taken (and why)

| prime/pi piece | Why we don't take it |
|---|---|
| `pi-ai` as the primary model client | Guppy's thin OpenAI-compatible client is the auditable, free-tier-tested core (20/20). pi-ai becomes catalog/capability, not the runtime. |
| `pi-coding-agent` session machinery | We have `SessionManager` (resume/checkpoints/merge-back) — tested. Theirs would be a lateral move, not an upgrade. |
| Their verification approach | Our graded ladder (syntax→typecheck→lint→tests→property→integration) is a differentiator; their `--autonomous-gate` is a flag, not a system. |
| Their TUI app wholesale | We take the `pi-tui` *framework* and build Guppy's interface on it; their app is wired to their session layer. |
| The generated 19k-line catalog checked into our repo | Depend on `pi-ai` on npm instead; catalog ships there, our repo stays small. |

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| pi-ai dependency size / install weight vs Guppy's "minimal free-tier" pitch | Keep it an optional dep of `@guppy/models`, lazy-load catalog, never on the hot path of `@guppy/core`; document the trade-off. |
| Version drift (pi-ai 0.84.x moves fast) | Pin versions; one small compatibility adapter (`@guppy/models`) so upgrades touch one file. |
| MCP spec churn | Depend on pi-ai's mcp client (they track the spec) rather than vendoring. |
| Dual model-config confusion | Single source of truth: `ModelConfig` stays Guppy's type; `@guppy/models` is the only mapper. |
| Test-suite regression on `main` | Work happens on `feature/nexus`; slices land with tests; CI matrix unchanged; `main` untouched until merge. |
| Licensing drift | `NOTICE` tracks every vendored file + dep; only MIT/Apache-compatible sources allowed. |

## 9. Sequencing & branch strategy

```
feature/nexus
├── Slice 0  foundation (deps + NOTICE + skeletons)      ─┐
├── Slice 1  catalog + /models + thinking        ←─ depends 0
├── Slice 2  MCP                                 ←─ depends 0
├── Slice 3  TUI (needs 1)                       ←─ depends 1
├── Slice 4  plan/build modes                    ←─ can start after 3
└── Slice 5  distributed skills                  ←─ can start after 3
Merge to `main` only per slice, each with green tests + CI.
```

## 10. Acceptance criteria — the "complete form"

`guppy chat` in a TTY gives you:

- [ ] A real TUI: streaming chat pane, input with slash autocomplete, no flicker.
- [ ] `/models` — searchable catalog of models with cost/context/reasoning metadata; `/provider` presets (OpenRouter, Groq, Gemini, OpenAI, Ollama, …).
- [ ] Model selection persisted per user (`~/.guppy/config.json`); keys from env or wizard.
- [ ] Thinking/reasoning-level control for models that support it.
- [ ] MCP: `guppy mcp add <server>` → server tools available to the agent, sandbox-contained.
- [ ] `/plan` and `/build` modes with a plan gate.
- [ ] `guppy skill install <pkg>` → skill usable by the context engine.
- [ ] Every claim covered by a test; full suite + CI green; `main` never broken mid-flight.

**Done = feature parity with opencode/Claude Code for the interface, on top of Guppy's verified engine — without rewriting what prime/pi already ship.**
