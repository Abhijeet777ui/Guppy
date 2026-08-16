# Nexus Agent Harness — Revised Architecture & Implementation Plan

> **Status:** 🚀 **BUILD MODE** — Active implementation.
> **Thesis:** A coding agent becomes substantially better at long-horizon software engineering when the harness actively manages **context → action → verification → experience → context** rather than simply giving an LLM more tools and tokens.

---

## 1. Core Architecture: Five Fundamental Systems

```
                    NEXUS
                      │
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
   CONTEXT        EXECUTION      VERIFICATION
   ENGINE           ENGINE          ENGINE
       │              │              │
       └──────────────┼──────────────┘
                      ↓
                 AGENT RUNTIME
                   (Prime/RLM)
                      │
                      ↓
                EVENT STORE
                      │
                      ↓
                SLEEP CYCLE
```

### Plugin Layer (added only when justified)
```
Memory • MCTS • Critic • Vector DB • Graph DB • Formal Verification
Firecracker • Prompt Optimizer • Skill Optimizer • Multi-Agent Scheduler
```

---

## 2. Key Architectural Decisions (Locked)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Control Plane Language** | TypeScript | Prime compatibility; sufficient perf; JSON/event routing not bottleneck |
| **Agent Runtime** | Prime via abstraction layer | Interchangeable; enables ablation experiments |
| **Execution (Phase 0-1)** | Docker containers | Prove need before Firecracker complexity; fast iteration |
| **Execution (Phase 2+)** | Firecracker + CRIU | Only if Docker proves insufficient for isolation/snapshotting |
| **Event Store** | Append-only JSONL + msgpack (local FS) | Central nervous system; enables replay, analysis, sleep cycle |
| **Graph DB** | None initially | Don't build storage before query requirements emerge |
| **Vector DB** | LanceDB (later) | Good embedded option; event store first |
| **Formal Verification** | Layered (TypeScript → Tests → Properties → Dafny) | Escalate only when necessary; budget-aware |
| **License** | Apache-2.0 | Commercial-friendly, patent grant |
| **Initial Target Repos** | TypeScript monorepos | Best tooling alignment; Prime already handles well |
| **MCTS / 7B Critic** | Delayed | Prove simpler approaches (beam search, critic comparison) first |
| **Self-Improvement** | Offline candidate generation + benchmark evaluation | Safety: Nexus proposes, benchmarks decide |

---

## 3. The Closed Loop (Nexus Thesis)

```
CONTEXT ENGINE
    ↓ "What should the agent see right now?"
ACTION (via Prime)
    ↓
VERIFICATION ENGINE
    ↓ "Was that action correct?"
EXPERIENCE / SLEEP CYCLE
    ↓ "What should we do differently next time?"
──────────────────→ CONTEXT ENGINE
```

---

## 4. Revised Implementation Roadmap

### Stage 0: Prove the Loop (Weeks 1-2) — **CURRENT**
**Goal:** `nexus run <repo> <task>` beats Prime baseline on controlled tasks

| Week | Deliverable | Owner |
|------|-------------|-------|
| 1 | Prime adapter (`AgentRuntime` interface) + Event Store + Workspace Manager | Backend |
| 1 | Basic Context Engine (task + files + test + error → dynamic context) | Backend |
| 1 | Verification Loop (typecheck → test → property test escalation) | Backend |
| 1 | CLI: `nexus run`, `nexus replay`, `nexus trace` | Frontend |
| 2 | End-to-end: Agent edits → test fails → context adjusts → agent recovers → passes | All |
| 2 | Baseline measurement harness (Prime vs Nexus on 20 controlled tasks) | All |

**Success Criteria:** Nexus + Context + Verification ≥ Prime +15% pass rate on same tasks, ≤1.5× tokens

---

### Stage 1: Long-Horizon Reliability (Weeks 3-5)
**Goal:** Survive multi-hour tasks with interruptions, recover from crashes

| Week | Deliverable |
|------|-------------|
| 3 | Checkpointing: full VM + kernel state snapshots (Docker commit → later CRIU) |
| 3 | Recovery: `nexus resume <session>` replays from last checkpoint |
| 4 | Structured Trajectory Store: indexed by task, outcome, failure pattern |
| 4 | Simple Memory: "last time this test failed, fix was X" retrieval |
| 5 | Sleep Cycle v1: nightly trajectory clustering → failure pattern report |

---

### Stage 2: Parallelism (Weeks 6-9)
**Goal:** Multi-agent speedup on decomposable tasks

| Week | Deliverable |
|------|-------------|
| 6 | Git worktree manager per subagent + virtual FS overlay |
| 6 | Contract-based DAG scheduler (decompose → parallel stages) |
| 7 | Merge Gate: 3-way merge + regression + contract conformance |
| 8 | Benchmark: parallel refactor tasks → measure speedup |
| 9 | Integration: SWE-bench Verified target 55% |

---

### Stage 3: Search (Weeks 10-13)
**Goal:** Better planning on high-risk tasks

| Week | Deliverable |
|------|-------------|
| 10 | Plan A / Plan B generation + Critic comparison (no MCTS yet) |
| 11 | Beam search over plan variants (budget: 3-5 candidates) |
| 12 | Value critic: collect trajectories → train 7B LoRA → evaluate |
| 13 | MCTS only if beam search + critic shows clear ceiling |

---

### Stage 4: Self-Improvement (Weeks 14-18)
**Goal:** Measurable week-over-week improvement without human intervention

| Week | Deliverable |
|------|-------------|
| 14 | Offline candidate generator: trajectory clusters → skill/prompt proposals |
| 14 | Benchmark harness: automated A/B evaluation (old vs new Nexus) |
| 15 | Promotion gate: statistical significance + regression check |
| 16 | Skill registry: executable learned procedures with tests |
| 17 | Prompt optimizer: GEPA/TextGrad on system prompt + skill prompts |
| 18 | Full benchmark: SWE-bench Verified ≥70%, LiveCodeBench ≥55% |

---

### Stage 5: Infrastructure Hardening (Weeks 19-24)
**Goal:** Production-grade deployment

| Week | Deliverable |
|------|-------------|
| 19 | Firecracker + CRIU migration (if Docker bottlenecks proven) |
| 20 | VM pool autoscaling, spot-instance tolerance |
| 21 | Distributed event bus (NATS/Redpanda) for multi-node |
| 22 | LanceDB vector memory + Kuzu graph memory (if queries demand) |
| 23 | Dafny integration for tagged critical-path files |
| 24 | Documentation, release, demo |

---

## 5. Repository Layout (Monorepo)

```
nexus/
├── apps/
│   ├── control-plane/          # TypeScript: SessionManager, ContextEngine, VerificationEngine, EventStore, CLI
│   ├── bench-runner/           # SWE-bench / LiveCodeBench / custom task harness
│   └── sleep-cycle/            # Nightly trajectory analysis, candidate generation
├── packages/
│   ├── agent-runtime/          # Prime adapter + AgentRuntime interface
│   ├── context-engine/         # Dynamic context selection, packing, cache optimization
│   ├── verification-engine/    # Layered verification (tsc → tests → properties → Dafny)
│   ├── event-store/            # Append-only log, snapshots, replay, trajectory index
│   ├── workspace/              # Docker/Firecracker exec, git worktrees, FS overlay
│   ├── memory/                 # Simple indexed memory → LanceDB/Kuzu later
│   ├── planner/                # DAG scheduler, beam search, MCTS (later), critic
│   └── contracts/              # Shared TypeScript types, gRPC protos, event schemas
├── infra/
│   ├── docker/                 # Base execution image (Node, Python, build tools)
│   ├── k8s/                    # Future: pool deployment, autoscaling
│   └── terraform/              # Future: cloud provisioning
├── specs/                      # ADRs, API contracts, event schemas
├── benchmarks/                 # Custom repo tasks, evaluation scripts
└── docs/
```

---

## 6. Immediate Next Steps (Week 1 Sprint)

### Day 1-2: Foundation
- [ ] `pnpm init` monorepo with workspace config
- [ ] `packages/contracts` — shared types, `AgentRuntime` interface, event schemas
- [ ] `packages/event-store` — append-only JSONL, snapshot, replay CLI
- [ ] `packages/agent-runtime` — Prime adapter implementing `AgentRuntime`

### Day 3-4: Execution & Workspace
- [ ] `packages/workspace` — Docker exec manager (create, exec, snapshot, cleanup)
- [ ] Git worktree manager for isolated agent workspaces

### Day 5: Context & Verification
- [ ] `packages/context-engine` — dynamic context selection (task + state → minimal context)
- [ ] `packages/verification-engine` — layered runner (typecheck → test → property)

### Day 6-7: Integration & Baseline
- [ ] `apps/control-plane` — wires everything: `SessionManager.run(task, repo)`
- [ ] CLI: `nexus run <repo> <task>`
- [ ] Baseline harness: run 20 tasks with Prime vs Nexus, measure pass/tokens/latency

---

## 7. AgentRuntime Interface (Contract)

```typescript
// packages/contracts/src/agent-runtime.ts

export interface AgentRuntime {
  /** Initialize runtime in a workspace */
  initialize(workspace: Workspace): Promise<void>;

  /** Run a single task to completion */
  run(task: Task, context: Context): Promise<Trajectory>;

  /** Resume from checkpoint */
  resume(checkpoint: Checkpoint): Promise<Trajectory>;

  /** Shutdown cleanly */
  shutdown(): Promise<void>;
}

export interface Task {
  id: string;
  description: string;
  repoPath: string;
  tags: string[];           // e.g., ['refactor', 'bugfix', 'architectural']
  verificationLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6;  // escalation budget
}

export interface Context {
  files: FileContent[];     // current file contents
  testResults: TestResult[];
  errors: Error[];
  memories: Memory[];       // retrieved from trajectory store
  skills: Skill[];          // applicable skills
  tokensUsed: number;
  maxTokens: number;
}

export interface Trajectory {
  taskId: string;
  events: Event[];
  outcome: 'success' | 'failure' | 'partial';
  finalState: Context;
  metrics: TrajectoryMetrics;
}

export interface TrajectoryMetrics {
  passes: number;
  failures: number;
  tokensTotal: number;
  tokensByModel: Record<string, number>;
  wallTimeMs: number;
  toolCalls: number;
  checkpoints: number;
}
```

---

## 8. Event Schema (Event Store)

```typescript
// packages/contracts/src/events.ts

type EventType =
  | 'TaskStarted'
  | 'ContextSelected'
  | 'ModelCalled'
  | 'ToolCalled'
  | 'ToolReturned'
  | 'FileChanged'
  | 'TestStarted'
  | 'TestPassed'
  | 'TestFailed'
  | 'TypecheckPassed'
  | 'TypecheckFailed'
  | 'VerificationEscalated'
  | 'CheckpointCreated'
  | 'AgentForked'
  | 'AgentMerged'
  | 'TrajectoryCompleted';

interface BaseEvent {
  id: string;           // ULID
  timestamp: number;    // epoch ms
  type: EventType;
  taskId: string;
  sessionId: string;
  payload: unknown;
}

interface ContextSelectedEvent extends BaseEvent {
  type: 'ContextSelected';
  payload: {
    included: string[];      // file paths, memory IDs, skill IDs
    excluded: string[];
    tokens: number;
    reasoning: string;       // why this context
  };
}

interface ToolCalledEvent extends BaseEvent {
  type: 'ToolCalled';
  payload: {
    tool: string;
    args: unknown;
    modelCallId: string;
  };
}
```

---

## 9. Success Criteria (Stage 0 Go/No-Go)

| Metric | Threshold |
|--------|-----------|
| `nexus run` cold start latency | <5s |
| Context selection reduces tokens vs full-repo | ≥40% reduction |
| Verification catches regressions before commit | ≥90% |
| Nexus pass rate on 20 controlled tasks | ≥ Prime +15% |
| Token cost per task | ≤ 1.5× Prime |
| Crash recovery (`nexus resume`) | <10s to resume point |

---

## 10. Decision Log (ADRs)

| ADR | Title | Status |
|-----|-------|--------|
| 001 | TypeScript Control Plane | ✅ Accepted |
| 002 | Prime via AgentRuntime Abstraction | ✅ Accepted |
| 003 | Docker First, Firecracker Later | ✅ Accepted |
| 004 | Event Store as Central Nervous System | ✅ Accepted |
| 005 | Layered Verification Budget | ✅ Accepted |
| 006 | Offline Self-Improvement (Sleep Cycle) | ✅ Accepted |
| 007 | No Graph/Vector DB Until Query Demand | ✅ Accepted |
| 008 | MCTS/Critic Delayed Until Simpler Search Proven | ✅ Accepted |

---

*Document version: 1.0 — Build Mode*  
*Date: 2025-08-08*