# BOOK-MASTER-PLAN — the cornerstone book on harness engineering (working plan)

> **Status:** master working plan · v0.2 · Aug 2026
> **One line:** a book that gives the harness field a *vocabulary, a taxonomy, a card format, and a compass* — and dissects one harness (Guppy) end to end so readers can read any other.
> **Sibling docs:** `HARNESS-BOOK.md` = the pitch + taxonomy + cards (concept). This file = everything needed to actually *write* the book. `docs/STATUS.md` = the product lab this book is built from.

---

## 1. The vision — what "cornerstone" actually means

The field has: vendor docs, blog posts, YouTube, two build-your-own books, and a 2026 wave of "harness engineering" essays (OpenAI, Fowler). **None of them give the reader a way to compare one harness to another or decide which to install.** That is the cornerstone gap.

**The book's four promises (each is a deliverable, not a chapter title):**

1. **A vocabulary** — one set of names for the parts every harness shares (the Six Organs) and the concepts that currently have no agreed name (the trust ladder, the envelope, compaction, the meter).
2. **A taxonomy** — the classification system: 6 axes, a trust ladder, an envelope axis, and a 2×2 "compass rose". Read any harness in 10 minutes.
3. **A card format** — the one-page Harness Card (the RFC of the field). Blank template + a filled card for every major harness.
4. **A compass** — the decision key: 5 personas → 4 quadrants → 3 candidate harnesses → a 15-question quiz. "More so than make one."

**Positioning sentence (the book's elevator):**
> "The model is the engine. The harness is the car. This is the first book that maps the whole garage."

**Non-goals (say them out loud in the intro):**
- Not a tutorial for building one specific harness (other books do that; we cite them).
- Not a vendor comparison ad.
- Not an LLM 101.
- Not a "10x your productivity" hype book — the tone is *engineering atlas*.

---

## 2. Audience & personas

| Persona | What they need | Where they live in the book |
|---|---|---|
| **The evaluator** — an engineer told "use an agent" | compare, choose, avoid the wrong one | Part III, the Cards, the Compass |
| **The builder** — making a harness/fork | the organs, the trust ladder, the failure modes | Part II, Appendix D (how to read a repo) |
| **The platform team** — choosing for an org | security (topology), cost (meter), gates | Ch 7, Ch 9 |
| **The power user** — Claude Code/OpenClaw daily | understand what's under the hood | Part I + II, light |
| **The researcher** — agents as a field | the taxonomy as a research instrument | the whole thing |

**The reader's takeaway (stated in the intro, delivered in the last chapter):**
> "By the end, you can pick up any harness repo you've never seen, fill its card in an hour, place it on the compass, and tell a colleague exactly when to use it and when not to."

---

## 3. The intellectual core — the taxonomy (refined)

### 3.1 The Six Organs (the anatomy every harness shares)

1. **Substrate** — what the harness is strapped to: `code-repo` · `desktop/os` · `editor` · `cloud workloads` · `chat apps` · `browser`.
2. **Steering** — who decides what happens next: `turn` · `task` · `daemon` · `subagent fleet` · `self-modifying`.
3. **Gate** — what must be true before output is accepted (the trust ladder, below).
4. **Memory** — what survives between turns: `none` · `session` · `workspace` · `campaign`.
5. **Topology** — where the loop runs: `your shell` · `sandbox/container` · `cloud VM` · `edge (LiteRT)` · `hybrid`.
6. **Economy** — model policy + what the meter shows: `first-party` · `BYO-key` · `free-tier router` · `self-hosted`.

### 3.2 The Trust Ladder (the book's signature concept — the Gate axis)

| Level | Who vouches | Example | Risk profile |
|---|---|---|---|
| 0 | nobody — output lands as-is | OpenClaw desktop modes | fast, dangerous |
| 1 | the harness itself (soft gates, self-report, learned skills) | Hermes skills, Claude Code hooks | feels safe, unproven |
| 2 | a human reviews diffs | Claude Code default, Cline | safe, slow, human is the bottleneck |
| 3 | **a machine verifies (tests/typecheck) before merge** | **Guppy** | the sweet spot nobody ships |
| 4 | RL/evals — quality is a measured, trained property | Prime verifiers, Antigravity eval stack | expensive, still rare |

**The book's thesis moment:** the industry is parked at level 2 while level 3 is buildable by a weekend project (Guppy is the proof). Level 4 is where the big labs are racing.

### 3.3 The Envelope Axis (the Memory organ, as a scale)

`one-shot` → `session` → `workspace (persistent files/memories/skills)` → `campaign (daemon, schedules, heartbeats)`.
The envelope decides everything about memory engineering (Ch 5).

### 3.4 The Compass Rose (the 2×2 every reader will remember)

- **X — Trust:** who vouches (model-self → machine gate → human review)
- **Y — Envelope:** how long a unit of work lives (task → session → campaign)

Quadrants:
1. **Trusted Chat** (human review, session) — Claude Code, Hermes, Cline
2. **Verified Builders** (machine gate, task/session) — **Guppy**, CI harnesses
3. **Sleepers** (self-trust, campaign) — OpenClaw daemon, Prime autonomous, Antigravity agents
4. **Factories** (self-improving, campaign) — Prime RLM, Hermes, Antigravity 2, DeepSeek Harness

### 3.5 The Harness Card (the RFC of the field)

Blank template lives in `HARNESS-BOOK.md` §4. **Standardize it**: every card is 12 fields, filled from *source* (repo + commit + file), with a one-sentence "Distinction" and a "Verdict". The card is the atomic unit of the book's Part III.

---

## 4. The corpus & the evidence system

### 4.1 The core set (full card + dissection)

| # | Harness | Repo | Local path | Lineage | Card status |
|---|---|---|---|---|---|
| 1 | Claude Code* | closed (docs/behavior) | — | independent | docs-based, mark `*` |
| 2 | pi | `@earendil-works` | `Harness/pi/` | substrate | source `dea1b248f` |
| 3 | Prime Agent | `PrimeIntellect-ai/prime-agent` | `Harness/prime-agent/` | pi + RLM | source `a18809e0` |
| 4 | Hermes Agent | `NousResearch/hermes-agent` | `research/hermes-agent/` | independent | source `aa26221` |
| 5 | OpenClaw | `openclaw/openclaw` | `research/openclaw/` | pi → own core | source `3a431bc5` |
| 6 | Antigravity | `google-antigravity/*` | `research/antigravity-*` | independent (Google) | source `4349e61` (SDK) |
| 7 | **DeepSeek Harness** | `deepseek-ai/deepseek-harness` | `research/deepseek-harness/` | Cordis meta-framework | source `99f6f02` |
| 8 | Guppy | this repo | `guppy/` | pi-tui + pi-ai deps | ours — full dissection |

### 4.2 Tier-2 (ecosystem map + one-paragraph cards, not full dissections) — all cloned

| Harness | Repo | Local path (commit) | Why it's in the book |
|---|---|---|---|
| Codex CLI | `openai/codex` | `research/codex/` (`13dfaab`) | OpenAI's agent-first harness (Rust); the exec-policy + sandbox approval model; the "harness engineering" essay it spawned |
| Gemini CLI | `google-gemini/gemini-cli` | `research/gemini-cli/` (`194edea`) | Google's terminal agent; free-tier economy (60 rpm / 1000 rpd); grounding; hooks; 1M ctx; ships an `a2a-server` |
| Cline | `cline/cline` | `research/cline/` (`26cb0ec`) | the IDE-extension archetype; approval-first UX; one agent core → CLI + Kanban (per-card worktrees) |
| OpenHands | `All-Hands-AI/OpenHands` | `research/OpenHands/` (`c41bda2`) | now "Agent Canvas" — a control-center meta-harness that drives Claude Code/Codex/Gemini over **ACP** |
| Aider | `Aider-AI/aider` | `research/aider/` (`5dc9490`) | the OG git-native harness; repo map (tree-sitter); "diff as the unit"; **Singularity 88%** self-written |

### 4.3 The evidence ledger (how we cite — non-negotiable)

- Every factual claim about a harness cites **repo + commit + file (+ line where possible)**.
- Cards record the commit they were read at; re-verify on a schedule (the field moves weekly — DeepSeek Harness shipped *4 days* ago).
- A `docs/book/evidence/` ledger tracks: claim → source → verified-by → date.
- Claude Code and Antigravity's engine are closed → their cards say so and cite docs/behavior instead.

### 4.4 The dissection checklist (reproducible method → Appendix D)

For every repo, extract:
1. **Boot & loop** — entrypoint, main loop, turn/task/daemon shape
2. **Tools** — how tools are defined; permission model; approval UX
3. **Gate** — what verifies output before accept/merge; merge-back behavior
4. **Memory** — what persists, where, format, compaction strategy
5. **Topology** — local/sandbox/cloud; isolation; security posture
6. **Economy** — model policy, provider routing, cost metering
7. **Interface** — TUI/IDE/gateway/channels; interrupt; themes
8. **Lineage** — deps, forks, shared substrate (pi-tui, pi-ai, Cordis…)
9. **Failure modes** — known bugs, error handling, silent-failure risks
10. **Evidence** — the 3–5 files that best prove the above

### 4.5 The lessons — what each harness teaches every reader

The pedagogical core. Every harness donates 2–4 **universal** lessons (not trivia about that product) that make readers better at reading, choosing, and building harnesses. Chapter tags show where each lands.

**pi — the minimal-extensible doctrine** (Ch 2, 5, 8)
- A harness doesn't need sub-agents or plan mode to be useful: minimal core + extension seams (Extensions/Skills/Prompts/Themes shipped as npm packages) beats a kitchen sink.
- The `.pi/` workspace dir is the "harness memory file" pattern — config, skills, prompts, git/npm state in one visible folder.
- Four modes (interactive / JSON / RPC / SDK) = one engine, many integration surfaces.

**Prime Agent — the RLM, or "context as variables"** (Ch 4, 6)
- A harness can treat the conversation as a *program*: persistent IPython kernel, context as variables, tools as recursive subagent calls. Radical steering.
- Self-improvement lives in harness state (Continual Harness, `/refine`), not the model — the harness edits its own operating instructions with evidence-backed updates.
- Bounded autonomy: daemon + turn/token/time budgets + quality gates — let it run unattended inside measurable limits.

**Hermes — the learning loop** (Ch 5, 7, 8, 9)
- Skills are the unit of learning: created from experience, improved during use, persisted as files.
- Memory is a *stack*, not a store: FTS5 session search + LLM summarization + Honcho user modeling.
- Micro-compaction: amortize context cost turn-by-turn instead of one big mid-session summarization (off by default — cost is real).
- Gateway pattern: one process serves many channels (Telegram/Discord/Slack/CLI) — the harness as a service.
- Seven terminal backends: topology is a choice, not a fact.

**OpenClaw — the meta-harness + policy** (Ch 3, 4, 7, 10, 11)
- A harness can *host* other harnesses: runtime registry + selection policy per model/provider (built-in OpenClaw vs Codex plugin).
- Tool policy + sandbox exec: the permission model is a first-class subsystem, not an afterthought.
- Maturity scorecard (`taxonomy.yaml`): evaluate subsystems with semantic coverage IDs, not vibes.
- The rename saga (Warelay→Clawdbot→Moltbot→OpenClaw) teaches: harness identity is volatile; the architecture survives the name.

**Antigravity — the compiled engine + open face** (Ch 2, 4, 7, 8)
- One "Core Agent Engine", many surfaces (CLI, GUI, SDK): the engine is the product; surfaces are distribution.
- The SDK abstracts the loop (policy / hooks / triggers / tools / connections) — the harness as a library.
- Edge inference (`connections/litert`) — topology extends to on-device.
- Eval-verified: quality as a measured property (the trust ladder's level 4).

**DeepSeek Harness — total modularity** (Ch 2, 9, 10)
- "Everything is a plugin" — even the agent loop itself is replaceable; no privileged core. The architectural extreme.
- Capability seams: explicitly mark which services are swappable (LLM adapter, token meter, compaction, tool-result pruning).
- Cordis meta-framework: plugins contribute services + typed events + *reversible effects* — unloading unwinds registration.
- Profiles/bundles as configuration: the whole product is a composable tree you can dump (`--dump-config`) and patch.
- Second meta-harness: calls Claude Code / Codex as sub-agents.

**Guppy — the verified builder** (Ch 4, 7, 8, 9)
- Machine gates before merge: tests/typecheck verify, only green lands — the trust ladder's level 3, proven by a weekend project.
- Worktrees + merge-back: the topology that makes verification safe (the OneDrive geometry bug taught the lesson).
- ContextOps meter: show the cost of every task.
- Live model discovery: never make the user memorize model ids.

**Codex CLI — the enterprise approval model** (Ch 2, 4, 8)
- Execution policy + sandboxing as first-class documented surfaces — the human-approval mechanics at enterprise scale.
- Rust implementation: harness performance as a product decision.
- Multi-surface (CLI / IDE / App / Web) on one engine — the distribution pattern again.

**Gemini CLI — free-tier + grounding + hooks** (Ch 5, 6, 9, 12)
- Free-tier economics are real and generous (60 rpm / 1000 rpd) — a hard data point for the Meter chapter.
- Grounding (Google Search) as a built-in tool — retrieval as a first-class capability.
- Hooks as the extension seam (the same seam Claude Code and Cline use).
- 1M-token context — the envelope's upper bound changes what memory must do.
- Ships an `a2a-server`: agent-to-agent protocol — the federated future.

**Cline — approval-first + agent-core apps** (Ch 4, 5, 8, 10)
- "Every action requires your explicit approval" — the philosophical opposite of machine gates; the human end of the approval spectrum.
- One agent core, many apps (IDE extension, CLI for CI, Kanban board with per-card worktrees + dependency chains) — parallel agents as a human-organized fleet.
- Auto-compact: context management as a feature.

**OpenHands / Agent Canvas — the control center + ACP** (Ch 7, 8, 10, 12)
- **ACP (Agent Client Protocol)**: a standard for driving any coding agent over JSON-RPC-on-stdio — the "USB-C of harnesses". Agent Canvas drives Claude Code / Codex / Gemini through it.
- The control-center pattern: a UI that orchestrates many harnesses + automations (Slack / GitHub / Linear, schedules / webhooks).
- Multi-backend topology (local / Docker / VM / cloud) as a first-class setting.

**Aider — the git-native OG** (Ch 4, 5, 10, 12)
- The repo map (tree-sitter): feed the right context without the whole codebase — the original context-engineering technique.
- Git-native diffs + auto-commit: the diff is the unit; git is the undo.
- **Singularity: 88%** — 88% of its own code written by itself. Self-hosting as a quality signal.
- Longevity: the 2023 tortoise still thriving in 2026 (6.8M installs) — the field's memory keeper.

---

## 5. The master outline (Part I–III + appendices)

### PART I — FOUNDATIONS (the vocabulary)

**Ch 1 — The Model Is Not the Product**
- Why the harness became the battleground (2024→2026 timeline compressed).
- The definition: *a harness converts a model into work* — six organs, one sentence.
- The four promises (vocabulary/taxonomy/cards/compass).
- The cast of characters (the 8 core + the tier-2).
- Guppy moment: `guppy run` on a real fixture — show the loop in one page.
- Research: the 2026 "harness engineering" wave (OpenAI, Fowler, the two books) — cite, then differentiate.

**Ch 2 — The Six Organs**
- One chapter per organ, short: what it is, what can go wrong, one example each.
- The Harness Card introduced as the "nutrition label" that names the organs.
- Guppy moment: map `guppy/` packages to organs (workspace→substrate, verification-engine→gate, event-store+memory→memory, models→economy, tui→interface).
- Deliverable: the blank card template is the chapter's artifact.

**Ch 3 — The Compass**
- The 6 axes (full definitions + how to read a harness against each).
- The Trust Ladder (the signature) and the Envelope axis.
- The Compass Rose 2×2 with every core harness placed.
- The "10-minute read": a worked example placing an unfamiliar harness (e.g., DeepSeek Harness) live.
- Deliverable: the compass diagram as the book's centerpiece figure.

### PART II — THE ORGANS IN DEPTH

**Ch 4 — The Gate (the hero chapter)**
- The trust ladder end to end, with the ecosystem's real answers:
  - Human review: Claude Code diffs/hooks; Cline.
  - Self-gates: Hermes learned skills; Claude Code hooks.
  - Machine gates: **Guppy L0→L3 → merge-back** (the weekend-project proof).
  - RL/evals: Prime verifiers + autonomous budgets; Antigravity eval stack; OpenClaw tool policy.
- The merge question: commit+merge (Guppy, Claude Code) vs mirror vs PR.
- Failure modes of each approach (the silent-failure bug we fixed is a case study).
- Guppy moment: the gate escalation trace from `docs/live/`.

**Ch 5 — Memory & the Envelope**
- The envelope axis: session → workspace → campaign.
- The persistence zoo: CLAUDE.md (Claude Code) · `.pi/` dir (pi) · Continual Harness (Prime) · FTS5+Honcho+skills (Hermes) · session-manager+skills (OpenClaw) · event store+memory (Guppy) · cloud sessions (Antigravity).
- **Compaction — the cost of remembering**: Hermes micro-compaction (amortized folding, off by default) vs Guppy ContextOps (token-savings meter) vs OpenClaw compaction hooks vs Prime compaction. One chapter's worth of comparison.
- The forgetting problem: what gets thrown away, and what that costs.

**Ch 6 — The Loop & Steering**
- Turn vs task vs daemon vs subagent fleet.
- The RLM (Prime) as the radical answer: context-as-variables, persistent IPython, tools as recursive subagent calls — from source (`prime-agent-runtime/src/rlm/`, deps ipykernel/nest-asyncio/tyro).
- Agent-to-agent: Prime's direct agent messaging; Antigravity's 90+ subagent fleet; Hermes subagents + RPC; OpenClaw subagent turns.
- Guppy moment: the turn loop `runChatTurn` → gated retry → memory.

**Ch 7 — Topology & Trust (the security chapter)**
- Your shell (Prime's explicit "not a sandbox" warning; Claude Code; Guppy `--local`).
- Sandbox/container (OpenClaw exec sandbox; Guppy Docker executor).
- Cloud VM / Cloud Run (Antigravity 2; Hermes' 7 backends incl. Modal/Daytona serverless).
- Edge (Antigravity SDK `connections/litert` — on-device inference).
- The "flip to cloud" pattern; the trust implications of each topology.
- Guppy moment: the worktree copy bug (`ERR_FS_CP_EINVAL`) as a topology lesson.

**Ch 8 — The Cockpit (interfaces)**
- Terminal TUI craft: the `pi-tui` lineage (pi, OpenClaw, Guppy all use `@earendil-works/pi-tui`); alt-screen layouts (pi's `tui-plan.md`); pickers, interrupts (our M3 AbortController), themes, exit dumps.
- The gateway/multi-channel pattern: Hermes + OpenClaw serving Telegram/Discord/Slack/WhatsApp/Signal/CLI from one daemon.
- The shared-engine pattern: Antigravity CLI + GUI on one "Core Agent Engine" with session export.
- The IDE-extension pattern: Cline.
- Guppy moment: M1–M3 (TUI, pickers, Ctrl+C interrupt) — we have the tests as evidence.

**Ch 9 — The Meter (economics)**
- Model policy: first-party (Claude Code, Antigravity) vs BYO-key (pi, Hermes, Cline, Guppy) vs free-tier router (Guppy's `:free` sorting) vs self-hosted (Ollama).
- The real cost of a task: tokens, tool calls, daily caps (Groq 200k TPD, OpenRouter free 50 req/day — measured in our bench).
- The meter: ContextOps saved-tokens metric as the model for honest cost display.
- Stall/failure economics: what a hung model costs (our 60s idle-timeout fix as the case study).

### PART III — THE ECOSYSTEM (the atlas)

**Ch 10 — The Family Tree**
- **The pi lineage: prime = pi + RLM kernel; OpenClaw = pi → own agent-core; Guppy = pi-tui + pi-ai.** One family, three harnesses — from source.
- Independent lineages: Claude Code, Hermes, Antigravity, DeepSeek Harness (Cordis), Codex, Gemini.
- The **meta-harness**: OpenClaw's harness registry (hosts Codex as a plugin); DeepSeek Harness calls Claude Code/Codex as sub-agents; OpenHands Agent Canvas drives any ACP agent. "Harness of harnesses" is now a trend, not an outlier.
- **The protocol stack (the book can be first to map it):** MCP (harness↔tools), **ACP** (harness↔harness — OpenHands, OpenClaw `src/acp/`, DeepSeek `packages/acp/`), **A2A** (agent↔agent — Gemini's `a2a-server`). Three letters, three seams; nobody has laid them out together.
- The generations: copilot → terminal agent → IDE agent → daemon → federated/self-improving.
- Deliverable: the family-tree diagram + generation timeline (Appendix C).

**Ch 11 — The Harness Cards (the encyclopedia)**
- Full cards for the 8 core harnesses (each 1–2 pages, source-cited).
- One-paragraph cards for the tier-2 five.
- The comparison gallery: the same 12 fields for all, side by side.
- The Decision Key: personas → quadrants → harnesses; the 15-question quiz.
- Guppy moment: Guppy's own card, written by its own code (dogfooding).

**Ch 12 — The Future of the Harness**
- Where the field is going: harness-of-harnesses, agent OS, federated agents, learning loops, verification-as-a-service, the "harness economy" (plugins, skills, cards as a marketplace).
- The open problems: the trust ladder's level 3 at scale; compaction that doesn't lose meaning; cross-harness memory; and whether the protocol stack (MCP/ACP/A2A) becomes the USB-C of the field.
- The emerging metrics worth adopting: Aider's Singularity (self-written share), token meters (ContextOps), maturity scorecards (OpenClaw's taxonomy.yaml).
- The book's parting claim: the harness, not the model, is where engineering happens now.

### APPENDICES

- **A. Glossary** — 40+ terms (harness, organ, trust ladder, envelope, compaction, meter, meta-harness, RLM, gateway, worktree, merge-back, ContextOps…).
- **B. The Harness Card** — blank template + 2 filled examples.
- **C. Timeline** — the field, 2024 → 2026 (with dates we can source).
- **D. How to Read a Harness Repo** — the dissection checklist as a reproducible skill.
- **E. The Guppy Dissection Map** — repo → organ → file (the appendix that proves the method).
- **F. Evidence Ledger** — how every claim is sourced and re-verified.

---

## 6. The book as a product

- **The Harness Compass (interactive site)** — 5 questions → your quadrant + 3 candidate harnesses. The book's homepage and its SEO magnet. "Classify, more so than make one" — as a product.
- **Open-source book repo** — the book itself in Markdown (like this one), a site build, and the evidence ledger public. The cornerstone book should be open; a paid polished edition (PDF/ebook + print) on top.
- **The card generator** — a small tool that turns a filled card into the comparison table; could grow into a community "cards registry" (the field's own standard).
- **Launch sequence** — ship the Compass + Ch 1 + the cards as free blog posts; then the book. Ride the 2026 "harness engineering" wave while it's cresting.

## 7. Writing workflow (meta: Guppy writes the book)

- The book repo is a git repo with the same gated loop: draft → verify → merge. **Dogfooding is the marketing.**
- Chapter drafts as tasks: "draft Ch 4 §3 (machine gates) from `verification-engine` + the live traces" — Guppy drafts, we review, gates check structure (word count, citations present).
- Evidence check is a gate: every paragraph with a factual claim must cite the ledger.
- Style: engineering atlas — short sentences, one idea per paragraph, diagrams over prose, "Guppy moment" box per chapter, "try it" exercises.

## 8. Timeline & milestones

| Milestone | Deliverable | Depends on |
|---|---|---|
| M0 — corpus | clone tier-2 + DeepSeek Harness; fill evidence ledger | user clones |
| M1 — taxonomy locked | Ch 1–3 first drafts + compass diagram + card template | M0 (light) |
| M2 — organs | Ch 4–9 drafts, each with Guppy evidence + 2 foreign-harness comparisons | M0 |
| M3 — atlas | Ch 10–12 + full cards + decision key + quiz | M1, M2 |
| M4 — product | Harness Compass site + open book repo + evidence ledger public | M3 |
| M5 — launch | free chapters + paid edition + launch posts | M4 |

## 9. Risks & open questions

- **Accuracy drift** — the field moves weekly (DeepSeek Harness shipped Aug 2026). Mitigation: commit-pinned evidence, re-verify schedule, "read at commit" honesty.
- **Legal** — trademarks/names are fine in commentary; don't reproduce vendor docs; mark closed-source claims. (No legal advice — get a review before publishing.)
- **The two existing books** — we differentiate hard: they build one harness; we map the field. Name them respectfully in Ch 1.
- **Scope creep** — resist adding a harness per week; the 8 core + 5 tier-2 is the line. New ones go in the compass, not the cards.
- **"Cornerstone" hubris** — earn it with the taxonomy + evidence, not the claim.

## 10. Immediate next actions

1. **Clone the additions** (user): DeepSeek Harness + tier-2 (commands below).
2. **Dissect DeepSeek Harness** — the Cordis meta-framework + "everything is a plugin" + calling Claude Code/Codex as sub-agents. New: a second meta-harness for Ch 10.
3. **Lock the taxonomy** — turn §3 of this doc into Ch 3's draft (the compass is the centerpiece).
4. **Fill Guppy's own card** (dogfooding) — it's the template test.
5. **Stand up the evidence ledger** at `docs/book/evidence/`.

---

## Clone commands for the corpus expansion

```powershell
cd "$HOME\OneDrive\Desktop\Projects\Harness\research"
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git
git clone --depth 1 https://github.com/openai/codex.git
git clone --depth 1 https://github.com/google-gemini/gemini-cli.git
git clone --depth 1 https://github.com/cline/cline.git
git clone --depth 1 https://github.com/All-Hands-AI/OpenHands.git
git clone --depth 1 https://github.com/Aider-AI/aider.git
```
