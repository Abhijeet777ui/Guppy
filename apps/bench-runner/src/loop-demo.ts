/**
 * Guppy close-the-loop demo — deterministic, no LLM required.
 *
 * Proves the Stage-0/1 wiring end to end on a seeded-bug fixture:
 *   1. agent edit (attempt 1, naive) -> suite still fails
 *   2. verification gate fires (level 3, `npm test`) and logs TestFailed
 *   3. ContextEngine re-selects context including the failure evidence
 *   4. agent recovers (attempt 2, guided by feedback) -> gate passes
 *   5. memory proof: run 2 of the same task retrieves run 1's distilled fix
 *      and feeds it into the context (learning compounds across runs)
 *
 * The loop shape is identical to runner.runGuppyWrapped; the only difference
 * is that the AgentRuntime is scripted, so the demo runs anywhere.
 */

import { appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ulid,
  now,
  ok,
  err,
  type Task,
  type Context,
  type Event,
  type Memory,
  type TestResult,
  type ErrorInfo,
  type Workspace,
  type AgentRuntime,
  type Checkpoint,
  type Trajectory,
  type Result,
  type ULID,
} from '@guppy/contracts';
import { createEventStore, type EventStore } from '@guppy/event-store';
import { createWorkspaceManager, type WorkspaceManager } from '@guppy/workspace';
import { ContextEngine } from '@guppy/context-engine';
import { createVerificationEngine } from '@guppy/verification-engine';
import { createMemoryStore, type MemoryStore } from '@guppy/memory';
import {
  BASE_FILES,
  getTask,
  materializeFixture,
  runTestSuite,
  type BenchTaskSpec,
} from './fixtures.js';
import { readWorktreeFiles, extractFailingTestNames } from './runner.js';

// ---------------------------------------------------------------------------
// Scripted runtime: attempt 1 = naive edit, attempt 2+ = guided repair
// ---------------------------------------------------------------------------

class ScriptedAgentRuntime implements AgentRuntime {
  private workspace: Workspace | null = null;
  private attempt = 0;

  constructor(
    private readonly spec: BenchTaskSpec,
    private readonly eventStore: EventStore,
  ) {}

  async initialize(workspace: Workspace): Promise<void> {
    this.workspace = workspace;
  }

  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    if (!this.workspace?.worktreePath) {
      return err(new Error('scripted runtime not initialized'));
    }
    this.attempt += 1;
    const dir = this.workspace.worktreePath;
    const guided = context.errors.length > 0 || context.testResults.some((t) => t.status === 'failed');

    const changed: string[] = [];
    if (this.attempt === 1 && !guided) {
      // Naive attempt: a cosmetic edit that does not address the defect.
      const target = this.spec.mutations[0]?.file ?? 'src/math-utils.ts';
      const abs = join(dir, target);
      appendFileSync(abs, '\n// attempt 1: agent inspected the code but found nothing suspicious\n', 'utf8');
      changed.push(target);
    } else {
      // Guided repair: undo every seeded mutation (the "learned fix").
      for (const mutation of this.spec.mutations) {
        const abs = join(dir, mutation.file);
        const content = readFileSync(abs, 'utf8');
        const restored = mutation.wholeFile
          ? BASE_FILES[mutation.file] ?? content
          : content.replace(mutation.replace, mutation.find);
        writeFileSync(abs, restored, 'utf8');
        changed.push(mutation.file);
      }
    }

    for (const path of changed) {
      this.eventStore.append({
        id: ulid(),
        timestamp: now(),
        type: 'FileChanged',
        taskId: task.id,
        sessionId: context.sessionId,
        payload: { path, operation: 'modify' },
      });
    }

    const trajectory: Trajectory = {
      id: ulid(),
      taskId: task.id,
      sessionId: context.sessionId,
      events: [],
      outcome: 'success',
      metrics: {
        passes: 0,
        failures: 0,
        tokensTotal: 0,
        tokensByModel: {},
        wallTimeMs: 0,
        toolCalls: changed.length,
        checkpoints: 0,
        contextSelections: 0,
        verificationEscalations: 0,
      },
      startedAt: now(),
      completedAt: now(),
    };
    return ok(trajectory);
  }

  async resume(_checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return err(new Error('scripted runtime does not support resume'));
  }

  async shutdown(): Promise<void> {
    // Nothing to release.
  }
}

// ---------------------------------------------------------------------------
// Demo orchestration
// ---------------------------------------------------------------------------

export interface LoopDemoStep {
  attempt: number;
  contextFiles: number;
  contextErrors: number;
  contextTestResults: number;
  contextMemories: number;
  gatePassed: boolean;
  suiteGreen: boolean;
}

export interface SingleRunOutcome {
  task: Task;
  steps: LoopDemoStep[];
  recovered: boolean;
  sessionIds: ULID[];
  /** Memories actually fed into context selections during this run. */
  memoriesFed: Memory[];
  finalSuiteGreen: boolean;
}

export interface LoopDemoReport {
  taskId: string;
  steps: LoopDemoStep[];
  gateFiredOnAttempt1: boolean;
  contextAdjustedOnAttempt2: boolean;
  recovered: boolean;
  finalSuiteGreen: boolean;
  eventCounts: Record<string, number>;
  /** Run 1 started with an empty memory store and fed no memories. */
  run1MemoryEmpty: boolean;
  /** Run 2 retrieved run 1's distilled fix and fed it into the context. */
  run2MemoryRetrieved: boolean;
  passed: boolean;
}

export interface LoopDemoOptions {
  outDir: string;
  taskId: string;
}

// ---------------------------------------------------------------------------
// One closed-loop pass (loop shape identical to runner.runGuppyWrapped)
// ---------------------------------------------------------------------------

async function runOnce(params: {
  spec: BenchTaskSpec;
  runId: string;
  outDir: string;
  memory: MemoryStore;
  workspaceManager: WorkspaceManager;
}): Promise<{ outcome: SingleRunOutcome; eventCounts: Record<string, number> }> {
  const { spec, runId, outDir, memory, workspaceManager } = params;

  const fixtureDir = join(outDir, 'fixtures', runId, spec.id);
  materializeFixture(spec, fixtureDir);

  const eventStore = createEventStore({
    rootDir: join(outDir, 'events', runId, spec.id),
  });

  const wsResult = await workspaceManager.createWorkspace(fixtureDir);
  if (!wsResult.ok) {
    throw new Error(`workspace creation failed: ${wsResult.error.message}`);
  }
  const workspace = wsResult.value;
  const worktreeDir = workspace.worktreePath ?? fixtureDir;

  const runtime = new ScriptedAgentRuntime(spec, eventStore);
  await runtime.initialize(workspace);

  const verifier = createVerificationEngine({
    eventStore,
    workspaceManager,
    projectRoot: worktreeDir,
    timeout: 120_000,
  });
  verifier.setWorkspace(workspace.id);

  const contextEngine = new ContextEngine();
  const task: Task = {
    id: ulid(),
    description: spec.description,
    repoPath: worktreeDir,
    tags: [spec.kind, runId],
    verificationLevel: 3,
    createdAt: now(),
    metadata: { benchTaskId: spec.id },
  };

  let testResults: TestResult[] = [];
  let errors: ErrorInfo[] = [];
  let memories: Memory[] = [];
  let previousContext: Context | undefined;
  const steps: LoopDemoStep[] = [];
  const memoriesFed: Memory[] = [];
  const sessionIds: ULID[] = [];
  const trajectories: Trajectory[] = [];
  let recovered = false;

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ctxResult = contextEngine.selectContext({
        task,
        availableFiles: readWorktreeFiles(worktreeDir),
        testResults,
        errors,
        memories,
        skills: [],
        ...(previousContext ? { previousContext } : {}),
      });
      if (!ctxResult.ok) {
        throw new Error(`context selection failed: ${ctxResult.error.message}`);
      }
      const context = ctxResult.value;
      sessionIds.push(context.sessionId);
      for (const m of context.memories) {
        if (!memoriesFed.some((known) => known.id === m.id)) memoriesFed.push(m);
      }

      const runResult = await runtime.run(task, context);
      const attemptTrajectory = runResult.ok ? runResult.value : null;
      if (attemptTrajectory) trajectories.push(attemptTrajectory);

      const gateResult = await verifier.verify(3, context, task);
      const gatePassed = gateResult.ok && gateResult.value.passed;
      const suite = await runTestSuite(worktreeDir);

      steps.push({
        attempt,
        contextFiles: context.files.length,
        contextErrors: context.errors.length,
        contextTestResults: context.testResults.length,
        contextMemories: context.memories.length,
        gatePassed,
        suiteGreen: suite.passed,
      });

      if (gatePassed) {
        recovered = true;
        break;
      }

      // Feed failure evidence + retrieved past fixes into the next context.
      testResults = [
        {
          id: ulid(),
          name: 'npm test',
          status: 'failed',
          duration: suite.durationMs,
          output: suite.output.slice(0, 4000),
          file: 'test/',
        },
      ];
      errors = [
        {
          id: ulid(),
          message: `Verification gate failed (exit ${suite.exitCode}). Failing output:\n${suite.output.split('\n').slice(0, 30).join('\n')}`,
          type: 'test',
          file: 'test/',
        },
      ];
      const failingNames = extractFailingTestNames(suite.output);
      const retrieved = failingNames.flatMap((name) => memory.retrieveForFailure(name));
      const seen = new Set<string>();
      memories = retrieved
        .filter((s) => (seen.has(s.memory.id) ? false : (seen.add(s.memory.id), true)))
        .map((s) => s.memory);
      previousContext = context;
    }

    await eventStore.close();

    // Distill this run into the shared memory store (the learning half).
    // Reload the persisted events first: the verification gate's
    // TestFailed/TestPassed events live in the store, not in the runtime
    // trajectories, and extractFixes needs the full
    // failure -> changes -> pass sequence to recognize a fix.
    const reader = createEventStore({
      rootDir: join(outDir, 'events', runId, spec.id),
    });
    const persistedEvents: Event[] = [];
    for (const sessionId of sessionIds) {
      const persisted = await reader.getTrajectory(task.id, sessionId);
      if (persisted) persistedEvents.push(...persisted.events);
    }

    // Event evidence from the SQLite index, gathered before teardown.
    const eventCounts: Record<string, number> = {};
    for (const sessionId of sessionIds) {
      const counts = reader.eventTypeCounts(task.id, sessionId);
      for (const [type, count] of Object.entries(counts)) {
        eventCounts[type] = (eventCounts[type] ?? 0) + count;
      }
    }
    await reader.close();

    if (trajectories.length > 0 || persistedEvents.length > 0) {
      const first = trajectories[0];
      const merged: Trajectory = {
        id: first?.id ?? ulid(),
        taskId: task.id,
        sessionId: first?.sessionId ?? (sessionIds[0] ?? ulid()),
        events: [...trajectories.flatMap((t) => t.events), ...persistedEvents].sort(
          (a, b) => a.timestamp - b.timestamp,
        ),
        outcome: recovered ? 'success' : 'failure',
        metrics: first?.metrics ?? {
          passes: 0,
          failures: 0,
          tokensTotal: 0,
          tokensByModel: {},
          wallTimeMs: 0,
          toolCalls: 0,
          checkpoints: 0,
          contextSelections: 0,
          verificationEscalations: 0,
        },
        startedAt: first?.startedAt ?? now(),
        completedAt: now(),
      };
      memory.ingestTrajectory(merged);
    }

    const finalSuite = await runTestSuite(worktreeDir);

    return {
      outcome: {
        task,
        steps,
        recovered,
        sessionIds,
        memoriesFed,
        finalSuiteGreen: finalSuite.passed,
      },
      eventCounts,
    };
  } finally {
    await runtime.shutdown();
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// ---------------------------------------------------------------------------
// Demo orchestration: run the same task twice on a shared memory store
// ---------------------------------------------------------------------------

export async function runCloseLoopDemo(options: LoopDemoOptions): Promise<LoopDemoReport> {
  const spec = getTask(options.taskId);
  if (!spec) {
    throw new Error(`unknown task: ${options.taskId}`);
  }

  // Shared across both runs: run 1 distills, run 2 must retrieve.
  const memory = createMemoryStore({ rootDir: join(options.outDir, 'memory') });
  memory.clear();
  const workspaceManager = createWorkspaceManager({
    dockerImage: 'guppy/executor:latest',
    useContainers: false,
    worktreeBase: join(options.outDir, 'worktrees'),
  });

  const run1 = await runOnce({
    spec,
    runId: 'loop-demo-run1',
    outDir: options.outDir,
    memory,
    workspaceManager,
  });
  const run2 = await runOnce({
    spec,
    runId: 'loop-demo-run2',
    outDir: options.outDir,
    memory,
    workspaceManager,
  });

  // Fixtures are scratch; the memory store + report are the durable output.
  rmSync(join(options.outDir, 'fixtures'), { recursive: true, force: true });

  const steps = [...run1.outcome.steps, ...run2.outcome.steps];
  const step1 = run1.outcome.steps[0];
  const step2 = run1.outcome.steps[1];

  const eventCounts: Record<string, number> = {};
  for (const counts of [run1.eventCounts, run2.eventCounts]) {
    for (const [type, count] of Object.entries(counts)) {
      eventCounts[type] = (eventCounts[type] ?? 0) + count;
    }
  }

  const run1MemoryEmpty = run1.outcome.memoriesFed.length === 0;
  const run2MemoryRetrieved = run2.outcome.memoriesFed.some((m) => m.type === 'fix');

  return {
    taskId: spec.id,
    steps,
    gateFiredOnAttempt1: !!step1 && !step1.gatePassed,
    contextAdjustedOnAttempt2:
      !!step2 && (step2.contextErrors > 0 || step2.contextTestResults > 0),
    recovered: run1.outcome.recovered && run2.outcome.recovered,
    finalSuiteGreen: run1.outcome.finalSuiteGreen && run2.outcome.finalSuiteGreen,
    eventCounts,
    run1MemoryEmpty,
    run2MemoryRetrieved,
    passed:
      !!step1 &&
      !step1.gatePassed &&
      !!step2 &&
      (step2.contextErrors > 0 || step2.contextTestResults > 0) &&
      run1.outcome.recovered &&
      run2.outcome.recovered &&
      run1.outcome.finalSuiteGreen &&
      run2.outcome.finalSuiteGreen &&
      run1MemoryEmpty &&
      run2MemoryRetrieved,
  };
}
