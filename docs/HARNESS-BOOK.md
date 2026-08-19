# HARNESS-BOOK — Blueprint for "The Harness Atlas" (v0.1, Aug 2026)

> Status: **incubating** — this is the workbench for the book, not a roadmap.
> The book idea: be **THE source** for harness engineering — not by teaching people
> to build another harness, but by giving the world a *classification system* for the
> ones that exist: an axis, a card format, a compass, and a corpus of case studies —
> with **Guppy as the one harness we take apart completely** (because it's ours).
> **Master plan:** [`BOOK-MASTER-PLAN.md`](BOOK-MASTER-PLAN.md) — the in-depth working plan (corpus, chapter outlines, evidence system, timeline).

---

## 0. The thesis (the pitch in 5 sentences)

1. A model is an engine; a **harness** is everything you strap around it — the tools, memory, gates, sandbox, and interface that convert a model into *work*.
2. In 2024–2026 the harness exploded into ten competing shapes (terminal agents, IDE agents, daemons, computer-use assistants, self-improving runtimes), but the field still has **no common vocabulary** and **no way to compare one harness to another on paper.
3. Existing books and courses teach *how to build one harness*. Nobody has written the **atlas**: what exists, along whom it differs, and how to *choose*.
4. This book fills that lane. Its spine is a **classification axis + a standardized one-page "Harness Card"** — read any harness in ten minutes, fill the card, know what to trust it with.
5. Guppy is the thread: one harness from zero to production, dissected chapter by chapter (this repo already contains every piece of evidence — ROADMAP, UX-SPEC, STATUS, the code).

## 1. Why now — and why the lane is still open

Verified via research (Aug 2026): the term "harness engineering" is real and racing —
OpenAI's *Harness engineering* post (Feb 2026), Martin Fowler's "Harness engineering for
coding agent users", an `awesome-harness-engineering` list, an arXiv paper (OpenDev),
a free 22-chapter open-source build-book, an Amazon "Harness Engineering" ebook.

**What none of them do** (the gap):
- None offer a **classification axis / taxonomy** as their centerpiece.
- None provide a **standard comparison format** (the Haskell Card) across products.
- None sell a **decision framework** ("which harness should *I* install?").
- None use a single fully-dissected open-source harness as the worked example.

They are *build* books. This is a *read + choose* book — "more so than make one."

## 2. The vocabulary — every harness is made of 6 organs

| # | Organ | Question it answers | Guppy's evidence (in repo) |
|---|-------|--------------------|----------------------------|
| 1 | **Substrate** | What world is it strapped to? (repo / desktop / browser / VM / chat apps) | worktree + merge-back (`packages/workspace`) |
| 2 | **Steering** | Who decides what happens next? (turn chat / goal-task / daemon / subagents / self-modify) | chat turn loop `runChatTurn`, `SessionManager` |
| 3 | **Gate** | What must be true before output is accepted? (nothing / human / machine verify / RL-verified) | `verification-engine` gates L0→L3 before merge — *Guppy's signature* |
| 4 | **Memory** | How much survives between turns? (none / session / workspace / campaign) | event store + memory package + ContextOps |
| 5 | **Topology** | Where does the loop physically run? | local `--local`, worktrees at `~/.guppy/worktrees` |
| 6 | **Economy** | What does a task cost, and who sees the meter? | ContextOps saved-tokens metric (the "meter"), free-tier routing, model catalog |

**The book's operating claim: every harness is 6-ish organs; once you can name them you can read any harness within the first hour.**

## 3. The compass — the classification axis (the heart of the book)

### 3.1 The one-sheet 2x2 (the "compass rose")

- **X — THE TRUST AXIS:** who vouches for the output before it lands?
  `model trusts itself` → `machine gate (tests/typecheck) verifies first` → `human reviews diffs`
- **Y — THE ENVELOPE AXIS:** how long does a unit of work live?
  `one-shot task` → `session` → `continuous campaign (daemon, schedules, heartbeats)`

```
                        Y → LONGER BLIVET
       ┌─────────────────────────────────────────┐
  MORE │  SLEEPERS                  FACTORIES     │
  MACH │  OpenClaw daemon,          Prime RLM      │
  GATE │  Prime /autonomous,        Hermes (grows  │
       │  Antigravity agents        with you)      │
       └───────────────┬──────────────────────────┘
                       │
       ┌───────────────┴──────────────────────────┐
       │  TRUSTED CHAT         VERIFIED BUILDERS   │
       │  Claude Code,         Guppy ★             │
  MORE │  Hermes CLI,          (verify → merge),   │
  HUMAN│  Cline, Codex agent   bench runners       │
  REVIEW│                     CI harnesses        │
       └──────────────────────────────────────────┘
              SHORTER       human → gate  → machine
```

### 3.2 The 6 detailed axes

**AXIS 1 — SUBSTRATE:** `code-repo` · `desktop/os (computer use)` · `editor` · `cloud workloads` · `chat apps` · `browser`. OpenClaw: desktop+chat apps. Guppy: code-repo. Antigravity 2.0: cloud.

**AXIS 2 — STEERING:** `turn-based` (user drives each loop) — Guppy/Claude Code chat · `goal-driven autonomous` (budgets: turns/tokens/time) — Prime `/autonomous`, Antigravity Mission Control · `daemon/scheduled` (heartbeats, `/heartbeat`) — Prime, OpenClaw · `team/francise` (orchestrated subagents) — Antigravity >90 parallel agents, Prime `rlm()` · `self-modifying` (harness rewrites its own operating state) — Prime `/refine`, Hermes "grows with you".

**AXIS 3 — GATE (the trust ladder — the book's pet axis):**

| Level | Who vouches | Example happens |
|---|---|---|
| 0 | nobody — model output is accepted | OpenClaw desktop modes |
| 1 | the harness itself (soft gates, self-report) | Hermes skills, Claude Code hooks |
| 2 | human (diff review, approvals) | Claude Code default flow, Cline |
| 3 | **machine (tests/typecheck verify before accept)** | **Guppy — the signature** |
| 4 | RL/evals (output is trained & evaluated, quality is a metric) | Prime PRIME-RL verifiers, Antigravity eval stack |

The book's thesis moment: **the industry is asleep at level 2 while level 3-4 is what makes a harness safe enough to hand work to; Guppy is our proof that level 3 is buildable for a weekend project.**

**AXIS 4 — MEMORY:** `none` · `session` · `workspace` (CLAUDE.md / memories / skills / LightRAG vector / event store) · `campaign` (the daemon that never sleeps; goals, schedules). Prime's Continual Harness, Hermes' LightRAG and skills, Guppy's event store + memory, Claude Code's CLAUDE.md.

**AXIS 5 — TOPOLOGY:** `your box (cwd, full user perms)` (Claude Code, Prime warning — *explicitly no sandbox*) · `container/sandbox` (OpenClaw sandbox exec) · `cloud VM / Cloud Run` (Antigravity 2) · `hybrid`.

**AXIS 6 — ECONOMY:** how models are chosen (`first-party bundle` Claude Code/Antigravity · `bring-your-own-key` Guppy/Hermes/Cline · `free-tier router` Guppy's `:free` list · `self-hosted` Ollama) — and what the meter shows. Guppy shows saved tokens per run (ContextOps) — **chapter-length material**.

## 4. The Harness Card — the one-page RFC for every harness

The book's standard asset. Fill it for every product and you can compare any two. Blank template:

```
HARNESS CARD — «name» (date, verified by)
─────────────────────────────────────────
Category     : terminal / IDE / daemon / computer-use / platform
Substrate    : [repo | desktop | cloud | chat | browser]
Steering     : [turn | task | fork | self-improving | daemon]
Gate         : [0..4]  + who/what verifies
Memory       : [none | session | workspace | campaign] + substrate
Topology     : [local | container | cloud | hybrid] + isolation note
Economy      : model policy, meter (per-run cost, saved tokens)
Interface    : TUI | IDE | web | chat app(s)
Trust notes  : sandbox? perms? diff review? merge behavior?
Distinction  : the one sentence that makes it — different
Verdict      : best for [persona] / don't use for [case]
─────────────────────────────────────────
Evidenced    : (sources + date)
```

**The book's payload: a filled card for every major harness + a comparison table at the end.**

## 5. The landscape — generation map (history chapter)

| Gen | Era | Shape | Example s |
|---|---|---|---|
| 1 | 2024 | Copilot ("write me a diff") | GitHub Copilot, Cursor |
| 2 | 2024-25 | Terminal agent (chat + repo) | Claude Code, Cline, OpenHands |
| 3 | 2025 | IDE agent (see it work) | Antigravity 1.0, Amp |
| 4 | 2025-26 | Long-running daemon (survives your screen) | Prime, OpenClaw, Hermes, Antigravity 2 |
| 5 | 2026? | Federated agent-OS (agents talk to agents) | Antigravity Agent Factory, Prime agent-to-agent |

**Guppy is deliberately Gen 2.5-3**: a modern terminal harness with a Gen-4-hard verification gate — the book's "you don't need a fleet to be trustworthy" exhibit.

## 6. The cards — from source (cloned corpus, Aug 2026)

### 6.1 The research corpus (cloned locally, read at these commits)

| Harness | Repo | Local path | Commit |
|---|---|---|---|
| pi (substrate) | `@earendil-works` (badlogic) | `~/…/Harness/pi/` | `dea1b248f` |
| prime-agent | `PrimeIntellect-ai/prime-agent` | `~/…/Harness/prime-agent/` | `a18809e0` |
| hermes-agent | `NousResearch/hermes-agent` | `~/…/Harness/research/hermes-agent/` | `aa26221` |
| openclaw | `openclaw/openclaw` | `~/…/Harness/research/openclaw/` | `3a431bc5` |
| antigravity-cli | `google-antigravity/antigravity-cli` | `~/…/Harness/research/antigravity-cli/` | — |
| antigravity-sdk-python | `google-antigravity/antigravity-sdk-python` | `~/…/Harness/research/antigravity-sdk-python/` | `4349e61` |

Claude Code is closed-source (its public repo is the installer shell) — its card comes from official docs + observed behavior, and is marked `*`.

### 6.2 The cards (8 core + tier-2 gallery; pi = the substrate layer)

| | Claude Code* | pi | Prime Agent | Hermes Agent | Antigravity | OpenClaw | DeepSeek Harness | Guppy |
|---|---|---|---|---|---|---|---|---|
| Steer | turn / task | turn (interactive / JSON / RPC / SDK) | pi + RLM REPL, daemon, subagents | turn + skills + gateway | fork / subagent fleet | daemon + chat + cron | plugin tree (web / headless profiles) | turn / task (gated) |
| Gate | human | hooks (no built-in gates) | budgets + verifiers + /refine | self-learned skills | cloud eval | policy + tool policy | approval + sandbox policy | **machine: tests L0→L3** |
| Memory | CLAUDE.md | `.pi/` (skills, prompts, git, npm) | Continual Harness | FTS5 + Honcho + skills | cloud sessions | session-manager + skills | session log + compaction services | event store + memory |
| Topology | local (+cloud) | local | local (daemon) + IPython kernel | 7 backends (local/Docker/SSH/Modal/…) | compiled runtime + cloud | local + sandbox exec | local; code-runtime / e2b sandbox | local (worktrees) |
| Economy | Claude API | BYO | MIT; provider or sub | OpenRouter/…; $5 VPS | Gemini | BYO keys | MIT; BYO (DeepSeek + any) | BYO + free-tier routing |
| Oddity | the reference | the common ancestor | "learns from every task" | "the agent that grows with you" | 0→OS under $1k, 93 agents | hosts multiple harnesses | "everything is a plugin" + calls Claude Code/Codex as sub-agents | level-3 gates + ContextOps meter |

**Tier-2 gallery (one-paragraph cards — ecosystem map, not dissections):**

| | Codex CLI | Gemini CLI | Cline | OpenHands (Agent Canvas) | Aider |
|---|---|---|---|---|---|
| Steer | turn / task | turn / task | turn (IDE) | control-center over many agents | turn / task |
| Gate | exec policy + sandbox | hooks | every action approved | ACP-driven (agent's own gates) | git diff review |
| Memory | skills | 1M ctx + hooks | auto-compact | per-agent | repo map + git |
| Topology | local sandbox | local (+IDE companion) | IDE + CLI + Kanban | local / Docker / VM / cloud | local |
| Economy | OpenAI | **free 60 rpm / 1000 rpd** | BYOK / $9.99 ClinePass | BYO | OpenRouter top-20 |
| Lesson | enterprise approval | free-tier + grounding | approval-first UX | ACP meta-harness | git-native + repo map + 88% Singularity |

### 6.3 Source evidence per harness (what the code actually proves)

**pi** — "a minimal terminal coding harness" (`packages/coding-agent/README.md`); deliberately skips sub-agents & plan mode, extends via Extensions / Skills / Prompt Templates / Themes shipped as npm "pi packages"; four modes (interactive / print+JSON / RPC / SDK). `packages/agent/src/harness/` dir + `tui-plan.md` (alt-screen layout: VStack/HStack/ScrollView) = the cockpit-chapter material. `.pi/` workspace dir = {extensions, git, npm, prompts, skills}.

**prime-agent** = pi + RLM. `package.json` workspaces are pi's own packages (agent/ai/coding-agent/tui) plus `prime-agent-runtime/` — a Python "Kernel-side runtime shim for Prime Agent recursion" (`pyproject.toml`: ipykernel, nest-asyncio, tyro; `src/rlm/`). The RLM is literally a Python/IPython kernel that treats context as variables and tools as recursive subagent calls; the "self-improvement" lives in the Continual Harness state, not the model.

**hermes-agent** — the learning-loop harness. Root-level `hermes_state*.py` (schema/search/portability), `trajectory_compressor.py`, `registration_lifecycle.py`; `docs/ADR.md` (multi-profile via ContextVar, gateway multiplexing), `docs/session-lifecycle.md` (`gateway/run.py` ≈16.8k lines), `docs/micro-compaction.md` — folds the oldest exchange into a running summary after *each* turn (off by default) instead of one big mid-session summarization. Skills are a first-class taxonomy (`skills/{devops,github,research,smart-home,…}`); memory = FTS5 session search + LLM summarization + Honcho user modeling; 7 terminal backends (local/Docker/SSH/Singularity/Modal/Daytona/Vercel); gateway serves Telegram/Discord/Slack/WhatsApp/Signal/CLI.

**openclaw** — the meta-harness. `docs/agent-runtime-architecture.md` + `src/agents/harness/` is a literal **harness registry with runtime-selection policy** (`registry.ts`, `selection.ts`, `auto-selection.ts`, `builtin-openclaw.ts`, `codex-app-server-extensions.ts`) — it hosts the built-in OpenClaw runtime *or* a plugin harness like Codex, selected per model/provider (`agentRuntime.id`). Reusable core in `packages/agent-core`; tool policy + native-hook-relay permissions; `taxonomy.yaml` is a **maturity scorecard** with semantic coverage IDs. VISION.md confirms the lineage: Warelay → Clawdbot → Moltbot → OpenClaw. Its legacy runtime alias "pi" normalizes to "openclaw" — it descended from pi too.

**antigravity** — the compiled-runtime + open-face harness. `antigravity-cli` is a thin TUI over a **shared "Core Agent Engine"** (same engine as the 2.0 GUI; sessions export between them; SSH-friendly). `antigravity-sdk-python` wraps the engine binary (ships in PyPI wheels — the engine itself is closed) and exposes the loop as an SDK: `policy` (permissions), `hooks` (lifecycle interceptors), `triggers` (scheduled/event), `tools` (custom tool runners), `connections/{local, local_openai, litert}` (LiteRT = on-device inference). "Abstracts the agentic loop."

**guppy** — the verified builder (this repo). Machine gates (L0→L3) before merge-back, worktrees at `~/.guppy/worktrees`, ContextOps meter, live model discovery. Lineage: shares `@earendil-works/pi-tui` with pi & openclaw, and the pi-ai catalog — see STATUS §3.12/3.14.

### 6.4 Cross-cutting discoveries (the book's "aha" material)

1. **One family, three harnesses.** pi (`@earendil-works`) is the common ancestor: prime = pi + a Python RLM kernel; openclaw's built-in runtime carries pi's legacy alias and still uses `pi-tui`; guppy uses `pi-tui` + the pi-ai catalog. Claude Code, Hermes, and Antigravity are independent lineages. A family tree is a whole chapter.
2. **The meta-harness exists.** OpenClaw's harness registry picks a runtime per model/provider — a harness that hosts other harnesses. "Harness of harnesses" is not hypothetical.
3. **The verification gap is real.** None of prime/hermes/openclaw/antigravity gate on tests before merging the way guppy does (prime has verifiers + autonomous budgets; openclaw has tool policy; antigravity has evals) — machine-verified merge remains guppy's lane, and it's the book's thesis chapter.
4. **Context engineering is converging.** Hermes micro-compaction (amortized folding) vs guppy ContextOps (token-savings meter) vs openclaw compaction hooks vs DeepSeek's compaction services — four answers to the same cost problem, one chapter's worth of comparison.
5. **The protocol stack is emerging — and it's the book's "plumbing" chapter.** MCP (harness↔tools), **ACP** (harness↔harness — OpenHands drives Claude Code/Codex/Gemini over it; OpenClaw has `src/acp/`; DeepSeek has `packages/acp/`), **A2A** (agent↔agent — Gemini ships an `a2a-server`). Three letters, three seams; nobody has mapped them together — the book can be first.
6. **The meta-harness is a trend, not an outlier.** OpenClaw (harness registry), DeepSeek Harness (calls Claude Code/Codex as sub-agents), OpenHands Agent Canvas (UI driving many ACP agents) — three independent teams converged on "harness of harnesses" in 2026.
7. **The approval spectrum is fully populated.** Cline ("every action requires your explicit approval") → Codex (exec policy + sandbox) → OpenClaw (tool policy) → Guppy (machine gates) → Hermes/Prime (self-gates) → Antigravity (evals). Every rung of the trust ladder now has a real, source-cited inhabitant.
8. **"One core, many surfaces" is the dominant distribution pattern.** Antigravity (CLI+GUI+SDK), Gemini (CLI+IDE companion), Cline (IDE+CLI+Kanban), Codex (CLI+IDE+App+Web). The engine is the product; the surface is distribution.
9. **The meter is real and measurable.** Gemini free = 60 rpm / 1000 rpd; Groq = 200k TPD; OpenRouter free = 50 req/day; Aider = OpenRouter top-20, 15B tokens/week. Ch 9 is now data-rich.
10. **Self-hosting is a quality signal.** Aider's "Singularity: 88%" — 88% of its own new code written by itself. A metric the field should adopt.

> Remaining flags before print: Claude Code card is docs/behavior-based (closed source); prime's exact pricing switch; antigravity's engine binary internals (closed); everything else is now source-cited at the commits above.

## 7. The decision key (Ch. 10 central table)

| "I am…" | Use | Avoid |
|---|---|---|
| dev married to my terminal | Claude Code / Prime / Guppy | GUI-first IDEs |
| dev with a repo full of tests | **Guppy-class (verified merges)** | no-gate tapes |
| non-dev, want my computer run errands | OpenClaw / computer-use | repo loops |
| AI-infra team on Google | Antigravity 2.0 | |
| research/long-running multi-day pipelines | Prime (daemon, goals, heartbeats) | session-only agents |
| want max context economy on a budget | provider-agnostic + free-tier (Guppy/ Hermes) | |

## 8. Book skeleton (10 chapters; each maps to Guppy milestones)

1. **The Model Is Not the Product** — the harness definition; why the ecosystem exploded; the missing vocabulary.
2. **The Six Organs** — anatomy; every harness is built of the same organs (Ch.5 evidence: `packages/workspace`, `verification-engine`, memory, models...).
3. **The Compass** — the axes + the rose; *the* chapter where the book earns its claim.
4. **The Gate** — verification as the overlooked hero. Guppy gate L0→L3 → merge; compare Prime budgets, Claude hooks, Antigravity evals. (Deepest chapter, referencing `verification-engine` + tests.)
5. **Memory Engines** — CLAUDE.md → Continual Harness → LightRAG → event store; what each costs in tokens and trust.
6. **Topology and Trust** — local vs container vs cloud; Prime's "not a sandbox" warning; OpenClaw's sandbox; worktrees.
7. **The Meter** — model economy: free-tier routing, ContextOps saved-tokens metric, §8 of our run-from-a-real-task data.
8. **The Cockpit** — TUI craft: pickers, arrow navigation, interrupt, themes, exit dump. (P02 = our M1-M3, already written in UX-SPEC + tests.)
9. **Harness Cards** — the encyclopedia: 6→8 full cards + comparison tables.
10. **The Decision Key** — personas, the table above, and a "15 questions" quick-install quiz.

Appendix A: The terminology glossary (the vocabulary the field lacks). B: Timeline of generations (Ch.
## 9. Studio decisions / open questions

- **Name:** *The Harness Atlas* | *Strapped* | *The Harness Book* — shortlist, decide later
- **Licensing/ethics:** names of products are fine; each card cites primary sources; mark ever verified
- **Cornerstone vs commodity:** the model is the commodity; the harness is the new battleground — the book's premise is that this battleground needs a common language
- **The site:** the book's homepage = an interactive *Harness Compass* (answer 5 questions → get your quadrant + 3 candidate harnesses) — the book becomes a product
- **Evidence:** we have the most *honest* raw material on Guppy (its failures get in too: OneDrive worktree bug, stall timeouts, etc). Nobody else ships that.

## 10. People reading with STATUS.md/ROADMAP (relationship)

The book is **not on the product roadmap** — it's the "project we tell the story of", and the product keeps serving as the lab. Every future milestone can donate a chapter section (e.g., M3 = Ch 8; MCP/slice 2 = Ch 9).