# Guppy — Competitor Analysis

*Honest comparison of Guppy against the coding-harness field. Competitor behavior is from working knowledge of their public products/architecture (search backend unavailable at writing — re-verify before citing externally). Guppy facts are from this repo, its tests, and its measured results.*

---

## 1. Positioning

Guppy's thesis: **the harness, not the model, decides what "done" means**, and the whole loop — context selection, tooling, verification, memory, benchmarking — is owned in-process with zero external agents and **bring-your-own-key, free tiers included**.

That puts it on the same shelf as Claude Code, Cursor, OpenHands, Aider, SWE-agent, and Codex — with one structural difference: a real, executable **verification gate** as the definition of success, plus a *measured* approach to context management that most competitors ship as an unverifiable black box.

### The field, briefly

| Harness | Core model | Success criterion | Context mgmt | Memory | Sandbox | Open source |
|---|---|---|---|---|---|---|
| **Claude Code** | Claude (Anthropic) | model "done" | LLM "condense" when full | /compact (conversation-only) | cwd, permission prompts | no |
| **Cursor** | multi (Claude/GPT/…) | model "done" | LLM compaction | codebase indexing/RAG | workspace, prompts | no |
| **OpenHands** | multi (incl. local) | model "done" | condense action; retrieval | conversation + web search | Docker (strong) | yes |
| **Aider** | multi (incl. local) | model "done" (+ auto-commit) | repo-map + auto-compact (truncate) | none | git, no sandbox | yes |
| **SWE-agent** | any API | model "done" (+ eval harness) | truncation | none | Docker | yes |
| **Codex CLI** | OpenAI | model "done" | auto-compact | conversation | cwd, permission prompts | no |
| **Gemini CLI** | Gemini | model "done" | LLM summarization | conversation | cwd, prompts | no |
| **Guppy** | **any OpenAI-compatible** (free tiers + local) | **executable verification gate** | **deterministic recap + optional LLM summary, measured** | **cross-run + cross-repo** | **Docker default + --local** | yes |

---

## 2. Where Guppy is genuinely better

### 2.1 The verification gate (the differentiator)
No mainstream harness runs your actual test suite as the *definition of done*. Claude Code, Cursor, OpenHands, Aider, and Codex all treat the model's "I'm done" as success — the classic failure mode where the model *believes* it fixed the bug. Guppy escalates a real ladder (typecheck → lint → unit → property → integration) and only merges when the gate is green, with per-test structured failures fed back into the next attempt. Measured: the same nemotron free model fixed `bugfix-clamp` in 1 attempt / 19k tokens under Guppy while prime-agent failed in 15 tool calls / 59k tokens.

### 2.2 Learning across runs and across repos
- **Cross-run:** a fix distilled from a failing→passing gate is retrieved into the next attempt's context — Aider/Codex/Cursor sessions are stateless by default.
- **Cross-repo:** fixes land in a global user store, so a fix learned in repo A is retrieved in repo B. Claude Code's `/compact` and Cursor's indexing are conversation- or codebase-scoped, not cross-repo procedural learning.
- **Distributed skills:** `guppy skill install` from a registry/URL/path with provenance — a reproducible way to share procedures, not just per-session memory.

### 2.3 Context management — deterministic floor + optional LLM summary + *measurement*
See §4 for the full comparison. The short version: we have **both** the LLM-summarization approach (like Claude Code/Cursor/OpenHands) **and** a deterministic, offline, zero-cost recap that cannot fail — plus events/metrics/ContextOps scoring that let us *prove* what the compression does. No competitor publishes its compaction's cost/benefit the way we measured ours (−87.6% scripted, −30% real, and the keep-6 default failure mode caught and fixed).

### 2.4 Model freedom + free-tier economics
Guppy runs on **any OpenAI-compatible endpoint**, including free tiers (nemotron free, Groq llama/qwen, Google AI Studio, local Ollama) with no vendor lock-in. It's the only harness in the set whose default benchmark config is *free-tier by design* — and whose launch thesis is "no API budget required."

### 2.5 Hermetic, measurable self-testing
21 fixtures + `sanity` (clean green / mutated red) + deterministic demos + ContextOps scoring on every payload + sleep-cycle offline failure clustering. You can A/B Guppy against *itself* (or against prime/pi baselines) on the same task/model. That's a level of observability no competitor exposes.

### 2.6 Auditability
Every run is a typed, durable event trajectory (`ModelCalled → ToolCalled → FileChanged → TestFailed → TrajectoryCompleted`) that you can `replay`/`trace`, not a chat transcript. That's the substrate for memory, benchmarking, and failure clustering — nothing reconstructed from logs.

---

## 3. Where Guppy is behind (honest)

| Gap | Detail | Mitigation / plan |
|---|---|---|
| **No proprietary frontier-model default** | We won't ship a polished claude-code-style UX tuned against a specific model; quality varies by the user's chosen model. | Catalog + thinking passthrough; free-tier models proven on the gate loop. |
| **No RAG over your codebase** | Cursor/OpenHands do semantic codebase search/embedding over the whole repo. Guppy's context engine selects files by errors/keywords, not embeddings. | A retrieval-first layer is the natural next slice (keeps big files out of context entirely). |
| **No multi-agent orchestration yet** | Fork/merge subagents (parallel investigation, reviewer) exist only as event types in contracts. | Roadmap item. |
| **Smaller ecosystem/plugins** | Cursor/Claude Code have MCP ecosystems, extensions, and CI integrations. Guppy supports MCP but ships no plugin market. | MCP bridge is in; ecosystem is an adoption problem, not an engineering one. |
| **UX polish ceiling** | TUI/REPL are solid and headless-verified but not a month of Anthropic design time. | M3 (visual sign-off) is the last UX box before launch. |
| **Windows/prime sidecars** | prime/pi baselines are Linux-oriented (WSL supported for prime). | Core runtime is cross-platform; sidecars are optional baselines. |

---

## 4. Deep dive: context management — Guppy vs the field

There are four families of context management in the wild:

1. **Drop-oldest / truncation** (SWE-agent, early Aider): silently cut old messages. Decisions vanish without a trace. *Guppy is strictly better — the recap preserves the task line, tool calls, and truncated results in order.*
2. **LLM condensation** (Claude Code "condense", Cursor compact, OpenHands condense, Codex auto-compact): a summarizer writes a semantic summary near the limit. Richer recaps, but costs a model call + latency, can drift/hallucinate details, and needs a good summarizer. **This is the mainstream default.**
3. **Huge native windows** (Gemini 1M–2M, Claude 200k–1M): some harnesses barely compress because they don't need to.
4. **Retrieval-first** (Aider repo map, OpenHands file search): never stuff whole files in — pull relevant snippets. *Prevention, not cure; Guppy does this in the context engine and it's where we're going deeper.*

**Guppy's position: hybrid — family 2's approach plus a deterministic floor (family 1's cheapness without its lossiness), measured.**

| Dimension | Claude Code / Cursor / OpenHands | Guppy |
|---|---|---|
| Semantic LLM summary | ✅ (their only mode) | ✅ optional (`--history-summary llm`) |
| Deterministic recap (offline, free, can't fail) | ❌ | ✅ default, with verbatim latest tool result |
| Fallback when the summarizer fails | partial (degrade) | ✅ deterministic recap + `summarySource` provenance |
| Cost | model call per compaction | **zero** in default mode |
| Latency | one summarizer round-trip | **zero** in default mode |
| Reproducibility | non-deterministic | byte-for-byte deterministic |
| Measured cost/benefit | unpublished | **events + metrics + ContextOps A/B (−87.6% scripted, −30% real)** |
| Default retention | hidden | 2 recent turns + 4k-char verbatim result (both A/B'd) |

**Our measured evidence (what competitors can't show you about their own feature):**
- Scripted 24-turn long-horizon run: **1,506,559 → 187,159 tokens (−87.6%)**, payloads bounded ~10.3k vs a 120k unbounded monster.
- Real-model A/B on a 47k-char ledger fixture: **−30% tokens with tight retention**; the no-compression control **failed outright at 866,731 tokens** — the exact failure compression exists to prevent.
- ContextOps (independent structural linter) confirms the token finding: the bad default retention produced 6 FAIL payloads / 52k wasted tokens; tight compression has zero FAIL payloads and the least waste (42 tokens).
- A real regression found and fixed: with the old default (6 recent turns exempt), compression fired 6× yet the run used **2× the tokens** — the model re-read the big file after every recap. Fixed by keeping the latest tool result verbatim and defaulting retention to 2.

---

## 5. The verdict

Guppy is not "another Claude Code." It's a **different tradeoff on the same axis, plus measurement nobody else has**:

- **Loses on:** polish, proprietary-model tuning, codebase RAG, ecosystem.
- **Wins on:** a real success criterion (the gate), model freedom + free-tier economics, cross-run/cross-repo learning, deterministic+hybrid context management that is *proven*, and the ability to self-benchmark and audit every run.

The winning move the analysis points to: keep the deterministic recap as the always-available floor, keep the optional LLM summary, add **retrieval-first file selection** so big files never enter context whole, and ship multi-agent under the same gate. That combination — gate + memory + measured compression + retrieval — is a genuinely leading position no current competitor occupies.
