/**
 * Session Manager — Orchestrates the full agent loop
 */

import type {
  AgentRuntime,
  Task,
  Context,
  Trajectory,
  Workspace,
  Result,
  TestResult,
  ErrorInfo,
  Memory,
  Skill,
  VerificationLevel,
  ULID,
} from '@guppy/contracts';
import { ok, err, ulid, now } from '@guppy/contracts';
import type { EventStore } from '@guppy/event-store';
import { createEventStore } from '@guppy/event-store';
import type { WorkspaceManager } from '@guppy/workspace';
import { createWorkspaceManager } from '@guppy/workspace';
import { loadSkills, type ContextEngine } from '@guppy/context-engine';
import { defaultSkillsDir } from '@guppy/skills';
import { defaultMemoryDir } from '@guppy/memory';
import type { VerificationEngine } from '@guppy/verification-engine';
import type { MemoryStore } from '@guppy/memory';
import { createMemoryStore } from '@guppy/memory';
import { join } from 'path';
import { deleteCheckpoint, saveCheckpoint, type RunCheckpoint } from './checkpoint.js';

export interface SessionManagerConfig {
  eventStore: EventStore;
  workspaceManager: WorkspaceManager;
  agentRuntime: AgentRuntime;
  contextEngine: ContextEngine;
  verificationEngine: VerificationEngine;
  memoryStore: MemoryStore;
  repoPath: string;
  maxTurns: number;
  verificationBudget: number;
  /**
   * Read-only runtime used by `plan()` (Slice 4). When absent, `plan()` falls
   * back to `agentRuntime` — but only the core runtime guarantees read-only
   * tools, so callers that want a no-edits plan pass a dedicated read-only
   * runtime here.
   */
  planRuntime?: AgentRuntime;
  /** Keep the worktree after the run instead of merging/destroying it. */
  keepWorktree: boolean;
  /** Commit-message template for merge-back; `{task}` is replaced with the task description. */
  commitMessage?: string;
  /** Merge changes back without creating git commits (files overlaid onto the repo). */
  noCommit?: boolean;
  /** With noCommit, overwrite uncommitted repo changes instead of refusing. */
  force?: boolean;
  /** Directory holding `<name>.md` skill files; defaults to `<repoPath>/.guppy/skills`. */
  skillsDir?: string;
  /** Per-user skills dir (installed skills follow the user across repos); defaults to `~/.guppy/skills`. */
  userSkillsDir?: string;
  /** Per-user global memory dir (fixes distilled here follow the user across repos); defaults to `~/.guppy/memory`. */
  userMemoryDir?: string;
}

export interface SessionState {
  task: Task;
  workspace: Workspace;
  context: Context;
  trajectory: Trajectory | null;
  turn: number;
  status: 'initializing' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
}

export class SessionManager {
  private config: SessionManagerConfig;
  private state: SessionState | null = null;
  /**
   * Skills for this run: the per-user installed skills (`~/.guppy/skills`,
   * which follow the user across repos) merged with repo skills. Repo skills
   * win name collisions — repo-specific teaching beats generic installs.
   */
  private skills: Skill[];

  constructor(config: SessionManagerConfig) {
    this.config = config;
    const repoSkills = loadSkills(config.skillsDir ?? join(config.repoPath, '.guppy', 'skills'));
    const userSkills = loadSkills(config.userSkillsDir ?? defaultSkillsDir());
    const byName = new Map<string, Skill>();
    for (const s of [...userSkills, ...repoSkills]) byName.set(s.name, s);
    this.skills = [...byName.values()];
  }

  async run(task: Task, signal?: AbortSignal): Promise<Result<Trajectory, Error>> {
    console.log(`[SessionManager] Starting task: ${task.description}`);

    // Initialize workspace
    const workspaceResult = await this.config.workspaceManager.createWorkspace(this.config.repoPath);
    if (!workspaceResult.ok) {
      return err(workspaceResult.error);
    }
    const workspace = workspaceResult.value;

    // Set workspace in verification engine
    this.config.verificationEngine.setWorkspace(workspace.id);

    // Initialize agent runtime
    await this.config.agentRuntime.initialize(workspace);

    // Gather initial context (establishes the session ID + file baseline)
    const contextResult = await this.gatherInitialContext(task, workspace);
    if (!contextResult.ok) {
      await this.config.workspaceManager.destroyWorkspace(workspace.id);
      return err(contextResult.error);
    }
    let context = contextResult.value;
    const sessionIds: ULID[] = [context.sessionId];

    // Open the event-store session so every appended event is persisted
    // under the same session ID the agent runtime will use
    this.config.eventStore?.beginSession(task.id, context.sessionId);

    // Initialize session state
    this.state = {
      task,
      workspace,
      context,
      trajectory: null,
      turn: 0,
      status: 'running',
    };

    // Pre-run baseline gate: the initial context should carry the repo's real
    // state, so the agent starts knowing what is already broken.
    let testResults: TestResult[] = [];
    let errors: ErrorInfo[] = [];
    let memories: Memory[] = [];
    const baselineLevel: VerificationLevel = task.verificationLevel >= 1 ? 1 : 0;
    if (!this.config.verificationEngine.levelAvailable(baselineLevel)) {
      // A missing tool (e.g. tsc in a dep-free repo) is an environment
      // condition, not an agent fault — skip the baseline rather than letting
      // `npx tsc` fetch a bogus package from the registry. Same wording as the
      // engine's own skip so the condition never reads two ways.
      console.log(
        `[SessionManager] Baseline gate (level ${baselineLevel}) skipped: ${this.config.verificationEngine.levelSkipReason(baselineLevel)}`,
      );
    } else {
      const baseline = await this.config.verificationEngine.verify(baselineLevel, context, task);
      if (baseline.ok && baseline.value.passed) {
        console.log(`[SessionManager] Baseline gate (level ${baselineLevel}) green`);
      } else {
        const baselineErrors = baseline.ok ? baseline.value.errors : baseline.error;
        const feedback = this.buildFailureFeedback(baselineErrors, `baseline level ${baselineLevel}`);
        testResults = feedback.testResults;
        errors = feedback.errors;
        memories = this.retrieveMemoriesFor(baselineErrors);
        console.log(`[SessionManager] Baseline gate (level ${baselineLevel}) red — feeding into initial context`);
      }
    }

    // Persist an initial checkpoint so a crash mid-attempt-1 can resume from
    // the baseline state instead of restarting the whole run.
    this.saveRunCheckpoint({
      task,
      attemptsCompleted: 0,
      testResults,
      errors,
      memories,
      context,
      workspace,
    });

    // Gated retry loop: the harness decides success, and every failed gate
    // feeds evidence + retrieved past fixes into the next attempt.
    let lastTrajectory: Trajectory | null = null;
    let lastGateErrors: string[] = [];
    let passed = false;
    try {
      for (let attempt = 1; attempt <= this.config.maxTurns; attempt++) {
        this.state.turn = attempt;

        const filesResult = await this.config.workspaceManager.listFiles(workspace.id);
        const ctxResult = this.config.contextEngine.selectContext({
          task,
          availableFiles: filesResult.ok ? filesResult.value : [],
          testResults,
          errors,
          memories,
          skills: this.skills,
          ...(attempt > 1 ? { previousContext: context } : {}),
        });
        if (!ctxResult.ok) {
          await this.teardown('failure');
          return err(ctxResult.error);
        }
        context = ctxResult.value;
        sessionIds.push(context.sessionId);
        this.state.context = context;

        const trajectoryResult = await this.config.agentRuntime.run(task, context, signal);
        if (!trajectoryResult.ok) {
          this.state.status = 'failed';
          await this.teardown('failure');
          return err(trajectoryResult.error);
        }
        lastTrajectory = trajectoryResult.value;
        this.state.trajectory = lastTrajectory;

        // The user interrupted (Ctrl+C): land the run as cancelled instead of
        // running another gate attempt. The trajectory already carries the
        // cancelled outcome; discard the worktree like a failure unless the
        // caller wants it kept.
        if (lastTrajectory.outcome === 'cancelled') {
          this.state.status = 'cancelled';
          deleteCheckpoint(this.config.repoPath, task.id);
          await this.teardown('cancelled');
          return ok(lastTrajectory);
        }

        // The model was never reachable (e.g. 429 quota after exhausting
        // retries): zero successful model calls, zero tool calls. This is an
        // infrastructure failure, not an agent outcome — running the gate
        // would escalate verification levels and run the repo's test suite
        // against a run that produced nothing, then report the gate's red
        // output as the cause (the run-summary masking dogfooding finding).
        // Short-circuit so the run fails fast with the real error.
        if (this.isModelUnreachable(lastTrajectory)) {
          this.state.status = 'failed';
          deleteCheckpoint(this.config.repoPath, task.id);
          await this.teardown('failure');
          return ok(lastTrajectory);
        }

        // Final verification gate for this attempt
        const gateResult = await this.config.verificationEngine.verifyWithBudget(
          context,
          task,
          task.verificationLevel
        );

        if (gateResult.passed) {
          passed = true;
          this.state.status = 'completed';
          break;
        }

        lastGateErrors = gateResult.errors.map((e) => e.message);
        console.log(
          `[SessionManager] Attempt ${attempt}/${this.config.maxTurns} failed the gate: ` +
            gateResult.errors.slice(0, 2).map((e) => e.message).join(' | ').slice(0, 160)
        );
        const feedback = this.buildFailureFeedback(gateResult.errors, `gate level ${task.verificationLevel}`);
        testResults = feedback.testResults;
        errors = feedback.errors;
        memories = this.retrieveMemoriesFor(gateResult.errors);

        // Checkpoint after every failed attempt: resume picks up at the next
        // attempt with this feedback and the workspace edits made so far.
        this.saveRunCheckpoint({
          task,
          attemptsCompleted: attempt,
          testResults,
          errors,
          memories,
          context,
          workspace,
        });
      }
    } finally {
      await this.distillRun(task, sessionIds, lastTrajectory, passed);
    }

    if (passed && lastTrajectory) {
      deleteCheckpoint(this.config.repoPath, task.id);
      await this.teardown('success');
      return ok(lastTrajectory);
    }

    // The harness decides success — not the agent's self-reported outcome.
    this.state!.status = 'failed';
    const failedTrajectory: Trajectory = lastTrajectory
      ? {
          ...lastTrajectory,
          outcome: 'failure',
          lastGatePassed: false,
          ...(lastGateErrors.length > 0 ? { gateErrors: lastGateErrors.slice(0, 5) } : {}),
        }
      : this.emptyTrajectory(task, context.sessionId);
    this.state!.trajectory = failedTrajectory;
    deleteCheckpoint(this.config.repoPath, task.id);
    await this.teardown('failure');
    return ok(failedTrajectory);
  }

  /**
   * Produce a plan without executing it (Slice 4 plan phase). This is the
   * read-only half of the plan/build split: a fresh workspace is created,
   * the read-only runtime explores the repo and answers with a plan, a
   * `PlanProduced` event is recorded, and the workspace is discarded — no
   * gate, no retry loop, no merge-back, because nothing was allowed to
   * change. The caller renders the plan and owns the approval step (`/build`).
   */
  async plan(
    task: Task,
    signal?: AbortSignal,
  ): Promise<Result<{ plan: string; trajectory: Trajectory }, Error>> {
    const runtime = this.config.planRuntime ?? this.config.agentRuntime;

    const workspaceResult = await this.config.workspaceManager.createWorkspace(this.config.repoPath);
    if (!workspaceResult.ok) {
      return err(workspaceResult.error);
    }
    const workspace = workspaceResult.value;

    await runtime.initialize(workspace);

    const contextResult = await this.gatherInitialContext(task, workspace);
    if (!contextResult.ok) {
      await this.config.workspaceManager.destroyWorkspace(workspace.id);
      await runtime.shutdown();
      return err(contextResult.error);
    }
    const context = contextResult.value;
    this.config.eventStore?.beginSession(task.id, context.sessionId);

    const trajectoryResult = await runtime.run(task, context, signal);
    if (!trajectoryResult.ok) {
      await this.config.workspaceManager.destroyWorkspace(workspace.id);
      await this.config.eventStore?.endSession();
      await runtime.shutdown();
      return err(trajectoryResult.error);
    }
    const trajectory = trajectoryResult.value;
    const plan = trajectory.finalAnswer ?? '';

    this.config.eventStore?.append({
      id: ulid(),
      timestamp: now(),
      type: 'PlanProduced',
      taskId: task.id,
      sessionId: context.sessionId,
      payload: { plan },
    });

    await this.config.eventStore?.endSession();
    // Nothing was allowed to change: discard the worktree instead of merging.
    await this.config.workspaceManager.destroyWorkspace(workspace.id);
    await runtime.shutdown();

    return ok({ plan, trajectory });
  }

  /**
   * Continue a previous run from its latest checkpoint: re-attach the saved
   * worktree, re-initialize the runtime, and pick the attempt loop back up at
   * `attemptsCompleted + 1` with the accumulated failure feedback.
   */
  async resumeTask(checkpoint: RunCheckpoint, signal?: AbortSignal): Promise<Result<Trajectory, Error>> {
    const { task } = checkpoint;
    console.log(
      `[SessionManager] Resuming task ${task.id} from attempt ${checkpoint.attemptsCompleted + 1}/${this.config.maxTurns}`,
    );

    const workspaceResult = await this.config.workspaceManager.adoptWorkspace(
      checkpoint.workspaceId,
      checkpoint.workspacePath,
      task.repoPath,
      checkpoint.containerId,
    );
    if (!workspaceResult.ok) {
      return err(workspaceResult.error);
    }
    const workspace = workspaceResult.value;

    this.config.verificationEngine.setWorkspace(workspace.id);
    await this.config.agentRuntime.initialize(workspace);

    let context: Context;
    if (checkpoint.context) {
      context = checkpoint.context;
    } else {
      const ctxResult = await this.gatherInitialContext(task, workspace);
      if (!ctxResult.ok) {
        await this.config.workspaceManager.destroyWorkspace(workspace.id);
        return err(ctxResult.error);
      }
      context = ctxResult.value;
    }

    this.state = {
      task,
      workspace,
      context,
      trajectory: null,
      turn: checkpoint.attemptsCompleted,
      status: 'running',
    };

    const sessionIds: ULID[] = [context.sessionId];
    let testResults: TestResult[] = checkpoint.testResults;
    let errors: ErrorInfo[] = checkpoint.errors;
    let memories: Memory[] = checkpoint.memories;
    let lastTrajectory: Trajectory | null = null;
    let lastGateErrors: string[] = [];
    let passed = false;

    try {
      for (let attempt = checkpoint.attemptsCompleted + 1; attempt <= this.config.maxTurns; attempt++) {
        this.state.turn = attempt;

        const filesResult = await this.config.workspaceManager.listFiles(workspace.id);
        const ctxResult = this.config.contextEngine.selectContext({
          task,
          availableFiles: filesResult.ok ? filesResult.value : [],
          testResults,
          errors,
          memories,
          skills: this.skills,
          ...(attempt > 1 ? { previousContext: context } : {}),
        });
        if (!ctxResult.ok) {
          await this.teardown('failure');
          return err(ctxResult.error);
        }
        context = ctxResult.value;
        sessionIds.push(context.sessionId);
        this.state.context = context;

        const trajectoryResult = await this.config.agentRuntime.run(task, context, signal);
        if (!trajectoryResult.ok) {
          this.state.status = 'failed';
          await this.teardown('failure');
          return err(trajectoryResult.error);
        }
        lastTrajectory = trajectoryResult.value;
        this.state.trajectory = lastTrajectory;

        // The user interrupted (Ctrl+C): land the run as cancelled instead of
        // running another gate attempt. The trajectory already carries the
        // cancelled outcome; discard the worktree like a failure unless the
        // caller wants it kept.
        if (lastTrajectory.outcome === 'cancelled') {
          this.state.status = 'cancelled';
          deleteCheckpoint(this.config.repoPath, task.id);
          await this.teardown('cancelled');
          return ok(lastTrajectory);
        }

        // Same short-circuit as the first attempt loop: a failure with zero
        // model tokens / tool calls is an unreachable model (429, bad key),
        // not an agent outcome — don't burn the gate on it.
        if (this.isModelUnreachable(lastTrajectory)) {
          this.state.status = 'failed';
          deleteCheckpoint(this.config.repoPath, task.id);
          await this.teardown('failure');
          return ok(lastTrajectory);
        }

        const gateResult = await this.config.verificationEngine.verifyWithBudget(
          context,
          task,
          task.verificationLevel,
        );

        if (gateResult.passed) {
          passed = true;
          this.state.status = 'completed';
          break;
        }

        lastGateErrors = gateResult.errors.map((e) => e.message);
        console.log(
          `[SessionManager] Attempt ${attempt}/${this.config.maxTurns} failed the gate: ` +
            gateResult.errors.slice(0, 2).map((e) => e.message).join(' | ').slice(0, 160),
        );
        const feedback = this.buildFailureFeedback(gateResult.errors, `gate level ${task.verificationLevel}`);
        testResults = feedback.testResults;
        errors = feedback.errors;
        memories = this.retrieveMemoriesFor(gateResult.errors);

        this.saveRunCheckpoint({
          task,
          attemptsCompleted: attempt,
          testResults,
          errors,
          memories,
          context,
          workspace,
        });
      }
    } finally {
      await this.distillRun(task, sessionIds, lastTrajectory, passed);
    }

    if (passed && lastTrajectory) {
      deleteCheckpoint(this.config.repoPath, task.id);
      await this.teardown('success');
      return ok(lastTrajectory);
    }

    this.state!.status = 'failed';
    const failedTrajectory: Trajectory = lastTrajectory
      ? {
          ...lastTrajectory,
          outcome: 'failure',
          lastGatePassed: false,
          ...(lastGateErrors.length > 0 ? { gateErrors: lastGateErrors.slice(0, 5) } : {}),
        }
      : this.emptyTrajectory(task, context.sessionId);
    this.state!.trajectory = failedTrajectory;
    deleteCheckpoint(this.config.repoPath, task.id);
    await this.teardown('failure');
    return ok(failedTrajectory);
  }

  /**
   * True when a failure trajectory means the model was never reachable (e.g.
   * a 429 rate limit after retries, or a bad key): no successful model call
   * (0 tokens) and no tool call ever ran. Same rule the bench runner applies
   * for its loud-failure path.
   */
  private isModelUnreachable(trajectory: Trajectory): boolean {
    return (
      trajectory.outcome === 'failure' &&
      !!trajectory.error &&
      trajectory.metrics.tokensTotal === 0 &&
      trajectory.metrics.toolCalls === 0
    );
  }

  /** Minimal empty trajectory used when a run fails before any attempt. */
  private emptyTrajectory(task: Task, sessionId: ULID): Trajectory {
    return {
      id: ulid(),
      taskId: task.id,
      sessionId,
      events: [],
      outcome: 'failure',
      metrics: {
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
      startedAt: now(),
      completedAt: now(),
    };
  }

  /** Persist resume state under `<repo>/.guppy/checkpoints/`. Best-effort. */
  private saveRunCheckpoint(params: {
    task: Task;
    attemptsCompleted: number;
    testResults: TestResult[];
    errors: ErrorInfo[];
    memories: Memory[];
    context: Context;
    workspace: Workspace;
  }): void {
    try {
      saveCheckpoint(this.config.repoPath, {
        version: 1,
        task: params.task,
        attemptsCompleted: params.attemptsCompleted,
        maxTurns: this.config.maxTurns,
        testResults: params.testResults,
        errors: params.errors,
        memories: params.memories,
        context: params.context,
        workspaceId: params.workspace.id,
        workspacePath: params.workspace.worktreePath ?? params.workspace.repoPath,
        ...(params.workspace.containerId ? { containerId: params.workspace.containerId } : {}),
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      // Checkpointing is best-effort — never fail the run over it.
      console.error(`[SessionManager] Checkpoint failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Distill the run into memory regardless of outcome. Gate outcomes
   * (TestFailed/TestPassed) live in the event store, not the runtime
   * trajectory — flush the log, then merge persisted events back in so
   * extractFixes sees the full failure -> change -> pass sequence.
   */
  private async distillRun(
    task: Task,
    sessionIds: ULID[],
    lastTrajectory: Trajectory | null,
    passed: boolean,
  ): Promise<void> {
    await this.config.eventStore?.endSession();

    const persistedEvents: Trajectory['events'] = [];
    for (const sessionId of new Set(sessionIds)) {
      const persisted = await this.config.eventStore?.getTrajectory(task.id, sessionId);
      if (persisted) persistedEvents.push(...persisted.events);
    }

    const base = lastTrajectory ?? this.emptyTrajectory(task, sessionIds[0] ?? ulid());
    if (base.events.length > 0 || persistedEvents.length > 0) {
      // The store already holds every runtime event (plus the gate's
      // Test/Typecheck events), so dedupe by id — concatenating base.events
      // with the replayed log would count the runtime events twice.
      const seen = new Set<string>();
      const events = [...base.events, ...persistedEvents]
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
      const distilled: Trajectory = {
        ...base,
        taskId: task.id,
        events,
        outcome: passed ? 'success' : 'failure',
      };
      this.config.memoryStore.ingestTrajectory(distilled);
    }
  }

  private async gatherInitialContext(
    task: Task,
    workspace: Workspace
  ): Promise<Result<Context, Error>> {
    // List files in workspace
    const filesResult = await this.config.workspaceManager.listFiles(workspace.id);
    if (!filesResult.ok) {
      return err(filesResult.error);
    }

    const contextResult = this.config.contextEngine.selectContext({
      task,
      availableFiles: filesResult.value,
      testResults: [],
      errors: [],
      memories: this.config.memoryStore.retrieve({ type: 'fix', limit: 5 }).map((s) => s.memory),
      skills: this.skills,
    });

    return contextResult;
  }

  /** Turn verification errors into the feedback a retry attempt receives. */
  private buildFailureFeedback(
    verificationErrors: Array<{ message: string; file?: string }>,
    source: string
  ): { testResults: TestResult[]; errors: ErrorInfo[] } {
    const summary = verificationErrors.map((e) => e.message).join('\n').slice(0, 4000);
    return {
      testResults: [
        {
          id: ulid(),
          name: `verification ${source}`,
          status: 'failed',
          duration: 0,
          output: summary,
        },
      ],
      errors: verificationErrors.map((e) => ({
        id: ulid(),
        message: e.message,
        type: 'verification' as const,
        ...(e.file ? { file: e.file } : {}),
      })),
    };
  }

  /** Learning loop: retrieve past fixes matching the current failures. */
  private retrieveMemoriesFor(verificationErrors: Array<{ message: string }>): Memory[] {
    const seen = new Set<string>();
    const memories: Memory[] = [];
    for (const e of verificationErrors) {
      for (const scored of this.config.memoryStore.retrieveForFailure(e.message)) {
        if (seen.has(scored.memory.id)) continue;
        seen.add(scored.memory.id);
        memories.push(scored.memory);
      }
    }
    return memories;
  }

  /**
   * Release the session: on success merge the agent's changes back into the
   * source repo (unless --keep-worktree); on failure discard the worktree
   * (unless --keep-worktree, so the user can inspect what went wrong). A
   * failed merge keeps the worktree and surfaces the path.
   */
  private async teardown(outcome: 'success' | 'failure' | 'cancelled'): Promise<void> {
    const workspace = this.state?.workspace;
    if (workspace) {
      if (outcome === 'success' && !this.config.keepWorktree) {
        const taskDescription = this.state?.task.description ?? '';
        const commitMessage = this.config.commitMessage
          ? this.config.commitMessage.replace(/\{task\}/g, taskDescription.slice(0, 100))
          : undefined;
        const merge = await this.config.workspaceManager.mergeBack(workspace.id, {
          ...(this.config.noCommit ? { noCommit: true } : {}),
          ...(commitMessage ? { commitMessage } : {}),
          ...(this.config.force ? { force: true } : {}),
        });
        if (merge.ok) {
          console.log(
            `[SessionManager] Merged agent changes into the repo (${merge.value.filesChanged} files changed)`,
          );
          await this.config.workspaceManager.destroyWorkspace(workspace.id, { deleteBranch: true });
        } else {
          console.error(
            `[SessionManager] Could not merge changes back (${merge.error.message}) — keeping the worktree at ${workspace.worktreePath}`,
          );
        }
      } else if (this.config.keepWorktree) {
        console.log(`[SessionManager] Keeping worktree at ${workspace.worktreePath} (--keep-worktree)`);
      } else {
        await this.config.workspaceManager.destroyWorkspace(workspace.id);
      }
    }
    await this.config.eventStore?.endSession();
    await this.config.agentRuntime.shutdown();
    this.state = null;
  }

  getState(): SessionState | null {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionManager(config: Partial<SessionManagerConfig> & {
  repoPath: string;
  agentRuntime: AgentRuntime;
  contextEngine: ContextEngine;
  verificationEngine: VerificationEngine;
}): SessionManager {
  const eventStore = config.eventStore || createEventStore();
  const workspaceManager = config.workspaceManager || createWorkspaceManager();

  return new SessionManager({
    eventStore,
    workspaceManager,
    agentRuntime: config.agentRuntime,
    contextEngine: config.contextEngine,
    verificationEngine: config.verificationEngine,
    memoryStore:
      config.memoryStore ??
      createMemoryStore({
        rootDir: join(config.repoPath, '.guppy', 'memory'),
        // Fixes distill into the per-user global store too, so they follow
        // the user across repos (cross-repo memory).
        secondaryRootDir: config.userMemoryDir ?? defaultMemoryDir(),
      }),
    repoPath: config.repoPath,
    maxTurns: config.maxTurns ?? 20,
    verificationBudget: config.verificationBudget ?? 3,
    keepWorktree: config.keepWorktree ?? false,
    ...(config.planRuntime ? { planRuntime: config.planRuntime } : {}),
    ...(config.userSkillsDir ? { userSkillsDir: config.userSkillsDir } : {}),
    ...(config.userMemoryDir ? { userMemoryDir: config.userMemoryDir } : {}),
    ...(config.commitMessage ? { commitMessage: config.commitMessage } : {}),
    ...(config.noCommit ? { noCommit: config.noCommit } : {}),
    ...(config.force ? { force: true } : {}),
  });
}