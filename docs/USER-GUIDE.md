# Guppy — User Guide

**Guppy** is a standalone software-engineering harness. You give it a repository and a task; it plans, edits, runs your tests, and — only when the **verification gate** is green — merges the fix back and remembers it. The harness, not the model, decides what "done" means.

This guide covers everything a user can do with Guppy today: setup, the CLI, the chat TUI/REPL, skills, MCP servers, context compression, benchmarking, and configuration.

---

## 1. Requirements & install

- **Node ≥ 20** and **pnpm 11** (`packageManager: pnpm@11.20.0`).
- **Docker Desktop** for the default sandboxed mode. Guppy runs without Docker via `--local` (plain worktrees on the host).

```bash
git clone <repo> && cd guppy
pnpm install
pnpm build          # compile all packages and apps
pnpm test           # 290 tests across 14 suites
```

Run the CLI two ways (equivalent):

```bash
pnpm cli -- <command>                 # e.g. pnpm cli -- chat
node apps/control-plane/dist/cli.js <command>   # direct
```

The benchmark tool has its own entry point:

```bash
node apps/bench-runner/dist/cli.js <command>    # guppy-bench
```

---

## 2. First run: add a model provider

Guppy is **bring-your-own-key** — it works with any OpenAI-compatible endpoint, including free tiers. No key is stored anywhere but your own `~/.guppy/config.json` (0600 permissions).

**Interactive wizard (recommended):**

```bash
pnpm cli -- setup
```

Pick a provider, paste a key, pick a default model (arrow keys). The catalog includes 39 providers / 1,200+ models; anything flagged *core-compatible* works with the native runtime.

**Scripted / headless:**

```bash
pnpm cli -- config set openrouter <KEY> --default-model nvidia/nemotron-3-super-120b-a12b:free
pnpm cli -- config path             # where the config lives
pnpm cli -- config remove <provider>
```

**Environment variables** also work (used when no config key exists):

| Provider | Env var |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Google AI Studio | `GEMINI_API_KEY` |
| DeepSeek / Mistral / xAI / Cerebras / Together / Fireworks | `DEEPSEEK_API_KEY` etc. |

Provider → base URL is auto-mapped (OpenRouter → `https://openrouter.ai/api/v1`, Groq → `https://api.groq.com/openai/v1`, NVIDIA → `https://integrate.api.nvidia.com/v1`, …); pass `--base-url` explicitly to override. Local endpoints (Ollama, LM Studio) need no key: `guppy chat --provider ollama`.

Browse the catalog without a key:

```bash
pnpm cli -- providers                 # 39 providers, model counts, core-compatibility
pnpm cli -- models --compatible       # only models the core runtime can drive
pnpm cli -- models qwen               # search by id/name
pnpm cli -- models --provider groq --limit 10
```

---

## 3. The verification gate

Every task runs a **verification ladder** — the harness's definition of done:

| Level | Check | Tools |
|---|---|---|
| 0 | Syntax / structure | (no-op stand-in) |
| 1 | Typecheck | `tsc --noEmit` |
| 2 | Lint | `eslint` |
| 3 | **Unit tests (default)** | `npm test` |
| 4 | Property tests | `npm run test:property --if-present` |
| 5 | Integration tests | `npm run test:integration --if-present` |
| 6 | Formal verification | **unsupported** (CLI rejects `-v 6`) |

- Set with `-v, --verification <level>` (default **3**).
- Levels escalate only while lower levels keep passing.
- A missing tool (e.g. no TypeScript in the repo) **skips** the level with a note (`'tsc' is not installed in this repo`) instead of failing or fetching junk from npm.
- When a repo has no installed `node_modules` but declares dependencies, guppy installs them **into the workspace** (never your repo) so the gate can resolve the repo's tools; `--no-install` disables this fallback. The install never writes a `package-lock.json` when the repo has none — a guppy run can't add lockfiles to your repo. An existing lockfile is respected and the install stays pinned to it.
- A **baseline gate** runs before the agent starts, so the model begins already knowing what's broken.

**Only a green gate counts as success.** The model's own "I'm done" is never trusted.

---

## 4. One-shot tasks: `guppy run`

```bash
pnpm cli -- run "the clamp test fails — fix src/math-utils.ts" -v 3
```

What happens: workspace created (Docker worktree by default, host with `--local`) → baseline gate → agent loop (model ↔ tools, up to `--max-turns`) → verification gate → on failure, evidence is fed into the next attempt → on success, changes are **committed and merged back** into your repo.

**Subagents (on by default).** The model also has a `subagent` tool for large, separable sub-tasks: it spawns a child agent that gets its own event-store trace, its own turn budget (6 by default, `max_turns` can lower it), and its own verification gate before anything is folded back into the main turn. The child's changes land in the workspace; if its gate fails, the tool reports an error and the main agent must fix or revert them. Children can spawn grandchildren up to a depth of 3; `--no-subagents` disables the tool entirely. A child never sees your MCP tools or this conversation — its task must be fully self-contained.

Full option set:

| Flag | Meaning |
|---|---|
| `-r, --repo <path>` | Repository to operate on (default: cwd) |
| `-m, --model <id>` | Model id (config default, else `claude-3-5-sonnet`) |
| `--provider <name>` | Provider (openai, openrouter, nvidia, groq, …) |
| `--base-url <url>` | Override the provider's base URL |
| `--api-key <key>` | Override the key (env/config used otherwise) |
| `--max-retries <n>` · `--retry-base-delay <ms>` · `--retry-max-delay <ms>` | 429/5xx/network retry & backoff |
| `--temperature <n>` · `--max-tokens <n>` · `--model-timeout-ms <ms>` | Sampling / completion cap / per-request timeout |
| `--thinking <level>` | Reasoning level (`off|minimal|low|medium|high|xhigh|max`) for catalog models that support it |
| `--no-stream` | Disable streaming (wait for full response) |
| `-t, --max-turns <n>` | Max model↔tool iterations per attempt (default 20) |
| `-v, --verification <level>` | Verification level 0–5 (default 3) |
| `--local` | Run on the host without Docker |
| `--max-history-tokens <n>` | Context-compression budget (see §7; default 60000, 0 = off) |
| `--history-summary <mode>` | `llm` = semantic recap via a summarizer call; `none` = deterministic recap (default) |
| `--keep-worktree` | Don't merge back; leave the worktree |
| `--commit-message <template>` | Merge-back commit template (`{task}` placeholder) |
| `--no-commit` | Overlay files onto the repo without git history |
| `--force` | With `--no-commit`, overwrite uncommitted repo changes |
| `--no-install` | Don't install missing deps into the workspace (levels needing them skip) |
| `--no-subagents` | Disable the recursive `subagent` tool (children spawn with their own trace, budget, and verification gate) |
| `-q, --quiet` | Suppress live streaming (summary only) |
| `--resume` | Resume the most recent interrupted run in this repo |
| `--no-mcp` | Skip registered MCP servers |

**Outcomes in the summary:** `success` (gate green, changes merged), `Task failed the verification gate` (with the gate's error messages), `Model unreachable` (0 tokens — quota/network/key problem, exit 1), `cancelled` (interrupted), or a partial end (turn budget).

---

## 5. Interactive chat: `guppy chat`

Two views over the *identical* engine — every message is a full gated task run:

- **Fullscreen TUI** — automatic on a real terminal. Scrollable transcript, markdown replies, a persistent context bar (`repo · model · verify · mode · saved`), a per-turn footer (`✓ 1.5s · 250 tokens · 1 tool calls · 2/0 tests · saved ≈10`), an activity spinner while busy, and a `/model` type-ahead picker.
- **Readline REPL** — automatic when stdin is piped (scripts, CI, `--no-tui`-style environments).

### Slash commands (both views)

| Command | What it does |
|---|---|
| `/help` | Show the command list |
| `/models [query]` | List core-compatible models; filter by query |
| `/provider [id]` | List providers, or set the active provider |
| `/model <id>` | Switch model mid-session (`/model qwen` opens a dropdown) |
| `/setup [p] [key]` | Show config, or store a provider key |
| `/thinking [level]` | Show or set the reasoning level |
| `/verify <0-6>` | Change the verification level for subsequent turns (6 = repo-declared invariant gate, skipped when unconfigured) |
| `/verbose` | Toggle raw event/engine logging |
| `/theme <dark\|light>` | Swap the TUI color scheme |
| `/plan` | Enter read-only planning mode (no edits) |
| `/build` | Approve the last plan and execute it through the gate |
| `/edit [text]` | Revise the pending plan by hand, then `/build` |
| `/exit`, `/quit` | Leave (Ctrl+C while idle also exits; Ctrl+C mid-turn cancels the turn) |

Anything else is treated as a task and run through the gated loop. On exit, Guppy prints a session summary (`3 turns · 410 tokens · 3 tool calls · 2/1 tests`).

### Plan → build workflow

```text
/plan                        # switch to read-only planning
fix the clamp                # model explores and writes a plan (no edits)
/build                       # approve it — runs through the full gated loop and merges
```

A plan can be revised with `/edit` before approving; revisions are recorded in the event trail (`PlanRevised`).

---

## 6. Skills: teach Guppy your conventions

A **skill** is a Markdown file with `name` / `description` / `tags` front-matter plus a prompt body. When a task matches its description/tags, the skill is injected into the model's context. Two origins:

- **Repo skills** — `<repo>/.guppy/skills/<slug>.md` (team-shared, committed).
- **User skills** — `~/.guppy/skills/` (cross-repo; repo wins name collisions).

```bash
# Author a repo skill
pnpm cli -- skill add "clamp-fix" "How to fix the clamp bug" --tags clamp,math --prompt "Run npm test first..."
pnpm cli -- skill list

# Install from a registry (default: the bundled guppy-builtin registry),
# a URL, or a local file
pnpm cli -- skill install                 # list the registry
pnpm cli -- skill install clamp-fix       # by registry name
pnpm cli -- skill install https://example.com/skill.md
pnpm cli -- skill install ./skill.md
pnpm cli -- skill install clamp-fix --registry ./my-registry.json
pnpm cli -- skill install clamp-fix --force   # overwrite an existing install

# Remove
pnpm cli -- skill remove clamp-fix
```

Installed skills carry `source:` / `installed-at:` provenance. Installs refuse duplicates without `--force`. Task-specific skills measurably flip gates (see `guppy-bench skill-demo`).

---

## 7. Context compression (long-horizon runs)

Free-tier models have small windows (nemotron 120k, qwen 32k, …) and a long task will blow them. Guppy compresses the conversation history once it crosses a budget:

- **`--max-history-tokens <n>`** (default **60000**, `0` = never compress). Once the estimated history exceeds the budget, older turns are replaced by a compact recap.
- **Deterministic recap (default, offline, zero cost):** the task line, tool calls, and truncated results are preserved in order; the **most recent tool result is kept verbatim** (capped) so the model doesn't re-read big files; the most recent **2 turns stay untouched**.
- **Hybrid LLM summary (`--history-summary llm`):** one summarizer call rewrites the recap as semantic prose (decisions, findings, what remains). Any failure falls back to the deterministic recap. Costs a bit of latency/tokens.
- The live stream shows `[compress] N turn(s) (X -> Y est. tok)`; every compression is recorded as a `ContextCompressed` event with before/after token estimates and `metrics.compressions` on the trajectory.

**Measured impact:** a scripted 24-turn run sent **87.6% fewer tokens** (payloads bounded at ~10.3k vs growing to 120k); a real-model A/B on the long-horizon ledger measured **−30% tokens with tight retention**, and the no-compression control **failed outright** at 866k tokens. On `chat`, use the same flags at launch (`guppy chat --max-history-tokens 4000 --history-summary llm`).

---

## 8. MCP servers: bring your own tools

Register any [MCP](https://modelcontextprotocol.io) stdio server; its tools join the agent's loop automatically.

```bash
pnpm cli -- mcp add fetch "npx" --args "-y,@modelcontextprotocol/server-fetch"
pnpm cli -- mcp add fetch "npx" --args "..." --force     # overwrite an existing name
pnpm cli -- mcp list
pnpm cli -- mcp remove fetch
```

- Config lives at `~/.guppy/mcp.json` (`--config` to override, `GUPPY_MCP_CONFIG` env).
- Names must be slug-safe; empty names/commands are rejected.
- **Safety:** servers start inside the workspace with a scrubbed environment (no API keys/tokens) and are force-killed with their whole process tree when the session ends. This is *containment, not a jail* — only add servers you trust.
- Skip loading with `--no-mcp` on `run`/`chat`. A broken server is logged and skipped, never fatal.

---

## 9. Benchmarking: `guppy benchmark` / `guppy-bench`

The hermetic suite (21 fixtures: bugfix / test-add / refactor + a long-horizon ledger) lets you A/B test the harness itself without spending tokens.

```bash
# Deterministic checks (no LLM, no key)
node apps/bench-runner/dist/cli.js list              # the 21 tasks
node apps/bench-runner/dist/cli.js sanity            # every fixture: clean green, mutated red
pnpm cli -- benchmark --dry-run --tasks bugfix-clamp # dry-run: materialize + gate only
node apps/bench-runner/dist/cli.js loop-demo         # closed-loop demo with a scripted model
node apps/bench-runner/dist/cli.js skill-demo        # skill-in-context flips the gate demo

# Real runs (needs a key)
pnpm cli -- benchmark --config guppy-core --tasks bugfix-clamp --max-attempts 1
node apps/bench-runner/dist/cli.js run --config guppy-core,guppy-core-skill --tasks bugfix-clamp
```

Key facts:

- **Default config is free-tier:** `openrouter` + `nvidia/nemotron-3-super-120b-a12b:free`. A non-dry-run with no key fails up front with `guppy setup` guidance instead of a surprise 401.
- Configs: `guppy-core` (native) and `guppy-core-skill` (skills injected) — the A/B pair. The prime/pi baselines were removed with `@guppy/agent-runtime` (external runtimes guppy doesn't need; subagents now cover delegation natively).
- Suites: `builtin` (hermetic) or a SWE-bench / LiveCodeBench JSONL dataset (`-s swe-bench --dataset path --repo checkout`).
- Every payload is captured and scored by **ContextOps** (context-health linter): per-config CHS, wasted tokens, and "tokens saved (est.)" appear in the report.
- `--dry-run` verdicts read as `CHECK <task>: fixture is red as expected (dry-run OK)` and `Dry-run OK: N/M …` — exit 1 only if a mutation failed to break the suite.
- `sleep-cycle` clusters failures across all recorded sessions offline (no LLM): which failures recur, whether they were ever resolved, and the candidate files that fixed them.

---

## 10. Configuration summary

| Path / env | Purpose |
|---|---|
| `~/.guppy/config.json` (`GUPPY_CONFIG`) | Provider keys + default model; 0600 perms |
| `~/.guppy/mcp.json` (`GUPPY_MCP_CONFIG`) | Registered MCP servers |
| `~/.guppy/skills` (`GUPPY_SKILLS_DIR`) | Per-user installed skills |
| `<repo>/.guppy/skills` | Repo skills |
| `<repo>/.guppy/memory` | Per-repo memory store (`~/.guppy/memory` / `GUPPY_MEMORY_DIR` = global cross-repo store) |
| `<repo>/.guppy/events` | Durable event store (msgpack + index) |
| `<repo>/.guppy/checkpoints` | Resume checkpoints |
| `<repo>/.guppy/context` | Captured model payloads (ContextOps scoring) |
| `<repo>/.guppy/bench` | Bench output (reports, fixtures, memory) |

Provider keys are read from config, then `PROVIDER_KEY_ENV`, then `OPENAI_API_KEY` — in that order.

---

## 11. Auditing a run

Every run is a typed, append-only event stream: `TaskStarted → ContextSelected → ModelCalled → ToolCalled → ToolReturned → FileChanged → TestPassed/Failed → VerificationEscalated → ContextCompressed → TrajectoryCompleted`. Replay or trace any of it:

```bash
pnpm cli -- trace <task-id>                 # all events for a task
pnpm cli -- trace <task-id> --session <id>  # one session
pnpm cli -- trace <task-id> --type ModelCalled
pnpm cli -- replay <task-id> <session-id>   # full session replay
```

---

## 12. Troubleshooting & FAQ

- **"Model unreachable" / HTTP 429** — free-tier daily quota exhausted (OpenRouter: 50 req/day, resets 00:00 UTC). Retry after the reset, add credits, or switch providers.
- **"No API key configured"** — run `guppy setup`, pass `--api-key`, or use a local provider (`--provider ollama`).
- **Docker errors on `run`** — start Docker Desktop, or use `--local`.
- **`'tsc' is not installed in this repo`** — the level is skipped; a repo with no test script can't be gated at level 3 — set `-v 0..2` or add a `test` script.
- **Paid-model surprise?** — no longer possible by default: `benchmark` defaults to free-tier nemotron on OpenRouter, and `run`/`chat` default to your config or the documented fallback. `guppy models --compatible` shows what your provider actually serves.
- **Long task blowing the context window?** — `--max-history-tokens 60000` is on by default; tune with `--history-keep-recent-turns` (not exposed as a flag on `run`/`chat`; available on `guppy-bench run`) and add `--history-summary llm` for semantic recaps.

See `docs/STATUS.md` for the full bug log (#1–#26, all fixed unless noted) and `docs/LAUNCH_CHECKLIST.md` for the launch roadmap.
