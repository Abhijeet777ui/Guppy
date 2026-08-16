/**
 * Pi Agent Runtime Adapter (reference / A/B baseline)
 * Implements AgentRuntime interface in-process using pi-agent-core + pi-ai.
 * The primary runtime is PrimeDaemonRuntime (prime-agent headless); this
 * adapter exists for ablation experiments and baseline comparisons.
 */

import type {
  AgentRuntime,
  Task,
  Context,
  Trajectory,
  TrajectoryMetrics,
  Checkpoint,
  Workspace,
  ULID,
  Event,
  Result,
  VerificationError,
} from '@guppy/contracts';
import { ulid, now, ok, err } from '@guppy/contracts';
import type { EventStore } from '@guppy/event-store';
import type { WorkspaceManager } from '@guppy/workspace';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool, AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { Type } from '@sinclair/typebox';

export interface PiAdapterConfig {
  eventStore: EventStore;
  workspaceManager: WorkspaceManager;
  defaultModel: Model<any>;
  maxTurns: number;
  /** Create a checkpoint every N turns (default 3). 0 disables checkpointing. */
  checkpointInterval?: number;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

interface GuppyWorkspaceToolParams {
  command: string[];
  workspaceId: string;
  cwd?: string;
  env?: Record<string, string>;
}

interface GuppyFileReadParams {
  path: string;
  workspaceId: string;
}

interface GuppyFileWriteParams {
  path: string;
  content: string;
  workspaceId: string;
}

interface GuppyListFilesParams {
  pattern?: string;
  workspaceId: string;
}

export class PiAgentRuntime implements AgentRuntime {
  private config: PiAdapterConfig;
  private currentWorkspace: Workspace | null = null;
  private currentTask: Task | null = null;
  private currentContext: Context | null = null;
  private currentTrajectoryId: ULID | null = null;
  private sessionId: ULID | null = null;
  private agent: Agent | null = null;
  private turnCount = 0;
  private trajectoryEvents: Event[] = [];
  private trajectoryOutcome: Trajectory['outcome'] = 'running';
  private abortController: AbortController | null = null;

  constructor(config: PiAdapterConfig) {
    this.config = config;
  }

  async initialize(workspace: Workspace): Promise<void> {
    this.currentWorkspace = workspace;
    console.log(`[PiAdapter] Initialized workspace: ${workspace.id}`);
  }

  async run(task: Task, context: Context): Promise<Result<Trajectory, Error>> {
    this.currentTask = task;
    this.currentContext = context;
    this.currentTrajectoryId = ulid();
    // Reuse the session ID chosen by the context engine so the event store
    // session and the trajectory agree on a single identity
    this.sessionId = context.sessionId || ulid();
    this.turnCount = 0;
    this.trajectoryEvents = [];
    this.trajectoryOutcome = 'running';
    this.abortController = new AbortController();

    try {
      // Log task start
      this.appendEvent({
        id: ulid(),
        timestamp: now(),
        type: 'TaskStarted',
        taskId: task.id,
        sessionId: this.sessionId,
        payload: { task },
      });

      console.log(`[PiAdapter] Starting task: ${task.description}`);

      // Build system prompt from context
      const systemPrompt = this.buildSystemPrompt(context);

      // Create pi Agent with Guppy tools
      this.agent = this.createAgent(systemPrompt);

      // Subscribe to agent events
      this.subscribeToAgentEvents();

      // Run the agent with the task
      const userMessage = this.buildUserMessage(task, context);
      await this.agent.prompt(userMessage);

      // Wait for completion
      await this.agent.waitForIdle();

      // Determine outcome
      this.trajectoryOutcome = this.determineOutcome();

      // Log completion
      this.appendEvent({
        id: ulid(),
        timestamp: now(),
        type: 'TrajectoryCompleted',
        taskId: task.id,
        sessionId: this.sessionId!,
        payload: {
          outcome: this.trajectoryOutcome,
          metrics: this.calculateMetrics(),
          lastGatePassed: this.lastGatePassed(),
        },
      });

      return ok(this.buildTrajectory());
    } catch (e) {
      this.trajectoryOutcome = 'failure';
      const error = e instanceof Error ? e : new Error(String(e));
      this.appendEvent({
        id: ulid(),
        timestamp: now(),
        type: 'TrajectoryCompleted',
        taskId: task.id,
        sessionId: this.sessionId!,
        payload: {
          outcome: 'failure',
          metrics: this.calculateMetrics(),
        },
      });
      return err(error);
    } finally {
      this.agent = null;
    }
  }

  async resume(checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    console.log(`[PiAdapter] Resuming from checkpoint: ${checkpoint.id}`);
    // Restore workspace from snapshot
    if (!this.currentWorkspace) {
      return err(new Error('No workspace initialized'));
    }

    await this.config.workspaceManager.restoreSnapshot(this.currentWorkspace.id, checkpoint.snapshotId);

    // Recreate agent with restored context
    return this.run(this.currentTask!, checkpoint.context);
  }

  async shutdown(): Promise<void> {
    console.log('[PiAdapter] Shutting down');
    this.abortController?.abort();
    this.agent = null;
  }

  private createAgent(systemPrompt: string): Agent {
    const tools = this.createGuppyTools();

    return new Agent({
      initialState: {
        systemPrompt,
        model: this.config.defaultModel,
        thinkingLevel: 'medium',
        tools,
      },
      streamFn: streamSimple,
      ...(this.config.getApiKey ? { getApiKey: this.config.getApiKey } : {}),
      toolExecution: 'parallel',
      maxRetryDelayMs: 30000,
      shouldStopAfterTurn: () => this.turnCount >= this.config.maxTurns,
    });
  }

  private createGuppyTools(): AgentTool<any>[] {
    const workspaceManager = this.config.workspaceManager;
    const workspaceId = this.currentWorkspace!.id;

    const execTool: AgentTool<any> = {
      name: 'exec',
      label: 'Execute Command',
      description: 'Run a shell command in the workspace container',
      parameters: Type.Object({
        command: Type.Array(Type.String()),
        cwd: Type.Optional(Type.String()),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      execute: async (toolCallId, params, signal) => {
        const execParams = params as { command: string[]; cwd?: string; env?: Record<string, string> };
        this.appendEvent({
          id: ulid(),
          timestamp: now(),
          type: 'ToolCalled',
          taskId: this.currentTask!.id,
          sessionId: this.sessionId!,
          payload: { tool: 'exec', args: params, modelCallId: toolCallId as ULID },
        });

        const result = await workspaceManager.exec(workspaceId, execParams.command, {
          ...(execParams.cwd !== undefined ? { cwd: execParams.cwd } : {}),
          ...(execParams.env ? { env: Object.entries(execParams.env).map(([k, v]) => `${k}=${v}`) } : {}),
        });

        this.appendEvent({
          id: ulid(),
          timestamp: now(),
          type: 'ToolReturned',
          taskId: this.currentTask!.id,
          sessionId: this.sessionId!,
          payload: {
            tool: 'exec',
            result: result.ok ? result.value.stdout : result.error.message,
            ...(result.ok ? {} : { error: result.error.message }),
            duration: result.ok ? result.value.duration : 0,
          },
        });

        if (!result.ok) {
          return { content: [{ type: 'text', text: `Error: ${result.error.message}` }], details: { error: true }, isError: true };
        }
        return { content: [{ type: 'text', text: result.value.stdout || '(no output)' }], details: { exitCode: result.value.exitCode } };
      },
    };

    const readFileTool: AgentTool<any> = {
      name: 'read_file',
      label: 'Read File',
      description: 'Read a file from the workspace',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (toolCallId, params) => {
        const readParams = params as { path: string };
        this.appendEvent({
          id: ulid(),
          timestamp: now(),
          type: 'ToolCalled',
          taskId: this.currentTask!.id,
          sessionId: this.sessionId!,
          payload: { tool: 'read_file', args: params, modelCallId: toolCallId as ULID },
        });

        const result = await workspaceManager.readFile(workspaceId, readParams.path);

        this.appendEvent({
          id: ulid(),
          timestamp: now(),
          type: 'ToolReturned',
          taskId: this.currentTask!.id,
          sessionId: this.sessionId!,
          payload: {
            tool: 'read_file',
            result: result.ok ? 'OK' : result.error.message,
            ...(result.ok ? {} : { error: result.error.message }),
            duration: 0,
          },
        });

        if (!result.ok) {
          return { content: [{ type: 'text', text: `Error: ${result.error.message}` }], details: {}, isError: true };
        }
        return { content: [{ type: 'text', text: result.value }], details: {} };
      },
    };

    const writeFileTool: AgentTool<any> = {
      name: 'write_file',
      label: 'Write File',
      description: 'Write a file to the workspace',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (toolCallId, params) => {
        const writeParams = params as { path: string; content: string };
        this.appendEvent({
          id: ulid(),
          timestamp: now(),
          type: 'ToolCalled',
          taskId: this.currentTask!.id,
          sessionId: this.sessionId!,
          payload: { tool: 'write_file', args: params, modelCallId: toolCallId as ULID },
        });

        const result = await workspaceManager.writeFile(workspaceId, writeParams.path, writeParams.content);

        this.appendEvent({
          id: ulid(),
          timestamp: now(),
          type: 'ToolReturned',
          taskId: this.currentTask!.id,
          sessionId: this.sessionId!,
          payload: {
            tool: 'write_file',
            result: result.ok ? 'OK' : result.error.message,
            ...(result.ok ? {} : { error: result.error.message }),
            duration: 0,
          },
        });

        if (!result.ok) {
          return { content: [{ type: 'text', text: `Error: ${result.error.message}` }], details: {}, isError: true };
        }
        return { content: [{ type: 'text', text: 'File written successfully' }], details: {} };
      },
    };

    const listFilesTool: AgentTool<any> = {
      name: 'list_files',
      label: 'List Files',
      description: 'List files in the workspace matching a pattern',
      parameters: Type.Object({ pattern: Type.Optional(Type.String()) }),
      execute: async (toolCallId, params) => {
        const listParams = params as { pattern?: string };
        this.appendEvent({
          id: ulid(),
          timestamp: now(),
          type: 'ToolCalled',
          taskId: this.currentTask!.id,
          sessionId: this.sessionId!,
          payload: { tool: 'list_files', args: params, modelCallId: toolCallId as ULID },
        });

        const result = await workspaceManager.listFiles(workspaceId, listParams.pattern);

        this.appendEvent({
          id: ulid(),
          timestamp: now(),
          type: 'ToolReturned',
          taskId: this.currentTask!.id,
          sessionId: this.sessionId!,
          payload: {
            tool: 'list_files',
            result: result.ok ? `${result.value.length} files` : result.error.message,
            ...(result.ok ? {} : { error: result.error.message }),
            duration: 0,
          },
        });

        if (!result.ok) {
          return { content: [{ type: 'text', text: `Error: ${result.error.message}` }], details: {}, isError: true };
        }
        return { content: [{ type: 'text', text: result.value.map(f => `${f.path} (${f.size} bytes)`).join('\n') }], details: { files: result.value } };
      },
    };

    return [execTool, readFileTool, writeFileTool, listFilesTool];
  }

  private buildSystemPrompt(context: Context): string {
    const parts = [
      'You are a senior software engineer working in a controlled workspace.',
      'You have access to tools for executing commands, reading/writing files, and listing files.',
      'Your goal is to complete the task by making minimal, focused changes.',
      '',
      '=== WORKSPACE INFO ===',
      `Workspace ID: ${this.currentWorkspace?.id}`,
      `Task: ${this.currentTask?.description}`,
      '',
      '=== RELEVANT FILES ===',
      ...context.files.map(f => `--- ${f.path} ---\n${f.content}`),
      '',
      '=== TEST RESULTS ===',
      ...context.testResults.map(t => `- ${t.name}: ${t.status}`),
      '',
      '=== ERRORS ===',
      ...context.errors.map(e => `- ${e.file}:${e.line} ${e.message}`),
      '',
      '=== INSTRUCTIONS ===',
      '1. First, explore the codebase to understand the structure',
      '2. Identify the root cause of any failures',
      '3. Make minimal fixes',
      '4. Run tests to verify your changes',
      '5. If tests fail, iterate with more context',
    ];
    return parts.join('\n');
  }

  private buildUserMessage(task: Task, context: Context): AgentMessage {
    const content = [
      `TASK: ${task.description}`,
      '',
      'Start by exploring the repository structure and understanding the codebase.',
      'Then implement the necessary changes to complete the task.',
      'Run tests frequently to verify your progress.',
    ].join('\n');

    return {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: now(),
    };
  }

  private subscribeToAgentEvents(): void {
    if (!this.agent) return;

    this.agent.subscribe(async (event, signal) => {
      if (signal.aborted) return;

      switch (event.type) {
        case 'message_start':
          if (event.message.role === 'assistant') {
            this.turnCount++;
          }
          break;

        case 'message_end': {
          // Log the model call here (not in the tools) so each call is
          // recorded exactly once, with real token usage from the provider
          if (event.message.role === 'assistant') {
            const msg = event.message;
            this.appendEvent({
              id: ulid(),
              timestamp: now(),
              type: 'ModelCalled',
              taskId: this.currentTask!.id,
              sessionId: this.sessionId!,
              payload: {
                model: msg.model,
                promptTokens: msg.usage?.input ?? 0,
                completionTokens: msg.usage?.output ?? 0,
                callId: ulid(),
              },
            });
          }
          break;
        }

        // ToolCalled/ToolReturned are logged by the tool wrappers themselves;
        // logging them here too would double-count every tool call.

        case 'turn_end':
          // Run verification after each turn
          await this.runVerificationAfterTurn();
          // Periodic checkpoint so `guppy resume` has something to resume from
          await this.maybeCheckpoint();
          break;

        case 'agent_end':
          break;
      }
    });
  }

  private async maybeCheckpoint(): Promise<void> {
    const interval = this.config.checkpointInterval ?? 3;
    if (interval <= 0) return;
    if (this.turnCount === 0 || this.turnCount % interval !== 0) return;
    if (!this.currentTrajectoryId || !this.currentContext) return;

    const result = await this.config.eventStore.createSnapshot(
      this.currentTrajectoryId,
      this.trajectoryEvents.length,
      this.currentContext,
      'periodic'
    );
    if (!result.ok) {
      console.error('[PiAdapter] Checkpoint failed:', result.error.message);
    }
  }

  private async runVerificationAfterTurn(): Promise<void> {
    if (!this.currentWorkspace || !this.currentTask || !this.currentContext) return;

    // Run typecheck (level 1)
    const verificationEngine = await this.createVerificationEngine();
    verificationEngine.setWorkspace(this.currentWorkspace.id);

    const result = await verificationEngine.verify(1, this.currentContext, this.currentTask);
    if (result.ok && !result.value.passed) {
      this.recordLocalEvent({
        id: ulid(),
        timestamp: now(),
        type: 'TypecheckFailed',
        taskId: this.currentTask.id,
        sessionId: this.sessionId!,
        payload: {
          errors: result.value.errors.map((e) => ({ file: e.file, message: e.message, line: e.line ?? 0 })),
          duration: result.value.duration,
        },
      });

      // Trigger context re-selection with new error info
      this.currentContext.errors = result.value.errors.map((e: VerificationError) => ({
        id: ulid(),
        type: 'type' as const,
        message: e.message,
        ...(e.file !== 'unknown' ? { file: e.file } : {}),
        ...(e.line !== undefined ? { line: e.line } : {}),
        ...(e.column !== undefined ? { column: e.column } : {}),
      }));
    } else if (result.ok) {
      this.recordLocalEvent({
        id: ulid(),
        timestamp: now(),
        type: 'TypecheckPassed',
        taskId: this.currentTask.id,
        sessionId: this.sessionId!,
        payload: { errors: [], duration: result.value.duration },
      });
    }
  }

  private async createVerificationEngine() {
    const { createVerificationEngine } = await import('@guppy/verification-engine');
    return createVerificationEngine({
      eventStore: this.config.eventStore,
      workspaceManager: this.config.workspaceManager,
      projectRoot: this.currentTask!.repoPath,
      timeout: 300_000,
    });
  }

  private determineOutcome(): Trajectory['outcome'] {
    // Budget exhaustion is not proven success — but lastGatePassed (carried
    // on the TrajectoryCompleted payload) lets reports tell "ran out of
    // turns while green" apart from "ran out of turns still red".
    if (this.turnCount >= this.config.maxTurns) return 'partial';
    // Judge on the most recent verification/test signals
    const lastEvents = this.trajectoryEvents.slice(-10);
    const hasFailure = lastEvents.some(e => e.type === 'TestFailed' || e.type === 'TypecheckFailed');
    if (hasFailure) return 'failure';
    const hasSuccess = lastEvents.some(e => e.type === 'TestPassed' || e.type === 'TypecheckPassed');
    return hasSuccess ? 'success' : 'partial';
  }

  /** Most recent verification/test signal, newest first. */
  private lastGatePassed(): boolean {
    for (let i = this.trajectoryEvents.length - 1; i >= 0; i--) {
      const type = this.trajectoryEvents[i]!.type;
      if (type === 'TestPassed' || type === 'TypecheckPassed') return true;
      if (type === 'TestFailed' || type === 'TypecheckFailed') return false;
    }
    return false;
  }

  private calculateMetrics(): TrajectoryMetrics {
    const metrics: TrajectoryMetrics = {
      passes: 0,
      failures: 0,
      tokensTotal: 0,
      tokensByModel: {},
      wallTimeMs: 0,
      toolCalls: 0,
      checkpoints: 0,
      contextSelections: 0,
      verificationEscalations: 0,
    };

    for (const e of this.trajectoryEvents) {
      switch (e.type) {
        case 'TestPassed':
          metrics.passes++;
          break;
        case 'TestFailed':
          metrics.failures++;
          break;
        case 'ModelCalled': {
          const tokens = e.payload.promptTokens + e.payload.completionTokens;
          metrics.tokensTotal += tokens;
          metrics.tokensByModel[e.payload.model] = (metrics.tokensByModel[e.payload.model] ?? 0) + tokens;
          break;
        }
        case 'ToolCalled':
          metrics.toolCalls++;
          break;
        case 'CheckpointCreated':
          metrics.checkpoints++;
          break;
        case 'ContextSelected':
          metrics.contextSelections++;
          break;
        case 'VerificationEscalated':
          metrics.verificationEscalations++;
          break;
      }
    }

    const events = this.trajectoryEvents;
    if (events.length > 1) {
      metrics.wallTimeMs = events[events.length - 1]!.timestamp - events[0]!.timestamp;
    }

    return metrics;
  }

  private buildTrajectory(): Trajectory {
    return {
      id: this.currentTrajectoryId!,
      taskId: this.currentTask!.id,
      sessionId: this.sessionId!,
      events: this.trajectoryEvents,
      outcome: this.trajectoryOutcome,
      metrics: this.calculateMetrics(),
      startedAt: this.trajectoryEvents[0]?.timestamp || now(),
      completedAt: now(),
    };
  }

  private appendEvent(event: Event): void {
    this.trajectoryEvents.push(event);
    this.config.eventStore.append(event);
  }

  /**
   * Record an event in the in-memory trajectory only. Used when another
   * component (the verification engine) has already appended the same event
   * to the event store, so persisting it here would double-count it.
   */
  private recordLocalEvent(event: Event): void {
    this.trajectoryEvents.push(event);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPiAdapter(config: PiAdapterConfig): PiAgentRuntime {
  return new PiAgentRuntime(config);
}