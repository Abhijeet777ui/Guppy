# Guppy

A next-gen agent harness for long-horizon software engineering. Instead of just giving an LLM more tools and tokens, Guppy actively manages the **context → action → verification → experience → context** loop.

## What it is

- **Native model client + tool loop** (`@guppy/core`) — talks to any OpenAI-compatible `/chat/completions` endpoint (OpenRouter, Groq, Google AI Studio, NVIDIA, local Ollama) with retry/backoff, per-request timeouts, streaming, and fenced-JSON / `<function/name>` text tool-call fallbacks for models that don't emit native tool calls.
- **Gated verify → retry → memory loop** (`@guppy/control-plane`) — baseline gate, attempt, verify (typecheck / lint / tests / property / integration), feed failures back into the next attempt, then **distill the fix into memory** and **merge the changes back into your repo**.
- **Benchmark harness** (`@guppy/bench-runner`) — a hermetic 20-fixture suite plus A/B configs (`core` vs `prime` vs `pi`), `--dry-run`, `loop-demo`, and offline failure clustering (`sleep-cycle`).
- **Docker sandbox** — the default launch mode, with path containment (including symlink defense) and container lifecycle management; local mode available via `--local`.
- **Event store** — append-only msgpack trajectories with a SQLite index, replay, trace, and live streaming.

## Quick start

Requirements: Node ≥ 20, pnpm 11, and Docker Desktop (for the sandbox default).

```bash
pnpm install
pnpm build
pnpm test        # 139 tests across 10 suites

# Interactive chat (needs a model key in the environment)
GUPPY_MODEL_PROVIDER=openrouter \
OPENROUTER_API_KEY=<your-key> \
pnpm cli -- chat

# One-shot gated task
pnpm cli -- run "fix the failing test"
```

See [`docs/STATUS.md`](docs/STATUS.md) for the verified status, capabilities, and bug log; [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md) for the launch roadmap; and [`docs/AUDIT-INSIGHTS.md`](docs/AUDIT-INSIGHTS.md) for the audit trail.

## Repository layout

```
apps/       control-plane (guppy CLI), bench-runner (guppy-bench), sleep-cycle
packages/   contracts, event-store, workspace, verification-engine,
            context-engine, memory, agent-runtime, core
docker/     executor sandbox image
docs/       status, capabilities, launch checklist, audit insights, recorded bench results
```

## Branching model

- **`main`** — the stable, verified harness: green build and full test suite.
- **`feature/nexus`** — forward-looking architecture and next-phase work (cross-repo memory, context compression, multi-agent, formal verification). Merged into `main` only once proven.

## Status

The learn → act → verify → remember loop is **proven on free tiers**: a clean full-suite run scored **20/20 fixtures passing** on `qwen/qwen3.6-27b` (Groq free — three keys, since each free key caps at 200k tokens/day). Merged evidence: [`docs/bench-results/launch-qwen-groq/merged-results.json`](docs/bench-results/launch-qwen-groq/merged-results.json). Earlier proof: nemotron-3-super-120b (OpenRouter free) 6/6 in one attempt each. See `docs/STATUS.md` for the full verified status and bug log.

Licensed under the Apache License, Version 2.0 — see [`LICENSE`](LICENSE).
