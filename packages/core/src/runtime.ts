/**
 * CoreAgentRuntime — Guppy's native in-process agent loop.
 *
 * The loop: build a system prompt from the selected context → call the model
 * with the workspace tools → execute tool calls through WorkspaceManager →
 * feed results back → repeat until the model answers or the turn limit is
 * hit. Every step is recorded as a Guppy event. No pi, no prime.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AgentRuntime,
  Checkpoint,
  Context,
  Event,
  Result,
  Task,
  Trajectory,
  TrajectoryMetrics,
  Timestamp,
  ULID,
  Workspace,
} from '@guppy/contracts';
import { err, now, ok, ulid } from '@guppy/contracts';
import type { EventStore } from '@guppy/event-store';
import type { WorkspaceManager } from '@guppy/workspace';
import type { ChatMessage, CompletionResult } from './openai-client.js';
import type { ModelConfig } from './model.js';
import { CancelledError, OpenAIChatClient } from './openai-client.js';
import { buildGuppyTools, READ_ONLY_TOOL_NAMES, type GuppyTool, type ToolExecution } from './tools.js';

export interface CoreRuntimeConfig {
  eventStore: EventStore;
  workspaceManager: WorkspaceManager;
  model: ModelConfig;
  /** Max model↔tool iterations within a single run (per gate attempt). */
  maxTurns: number;
  /**
   * Stream model output through the event store as `ModelStreamed` events
   * (throttled) instead of waiting for the full response. The accumulated
   * text still drives tool-call parsing unchanged.
   */
  stream?: boolean;
  /**
   * Read-only mode: only the non-mutating native tools are exposed, and
   * `extraTools` (which can't be proven read-only) are dropped. Used by the
   * Slice 4 plan phase — a plan can explore the workspace but can never edit
   * it, run commands, or patch.
   */
  readOnly?: boolean;
  /**
   * When set, dump the exact `{ model, messages, tools }` payload before every
   * model call into this directory (one JSON file per turn). Used by the bench
   * to score context health with ContextOps before/after inference.
   */
  contextCaptureDir?: string;
  /**
   * External tools appended to the native set in initialize() — e.g. MCP
   * server tools bridged by `@guppy/mcp`. They share the same loop, events,
   * and result plumbing as the built-ins.
   */
  extraTools?: GuppyTool[];
}

const MAX_TOOL_RESULT_CHARS = 20_000;

export class CoreAgentRuntime implements AgentRuntime {
  private readonly config: CoreRuntimeConfig;
  private readonly client: OpenAIChatClient;
  private workspace: Workspace | null = null;
  private tools: GuppyTool[] = [];

  constructor(config: CoreRuntimeConfig) {
    this.config = config;
    this.client = new OpenAIChatClient(config.model);
  }

  async initialize(workspace: Workspace): Promise<void> {
    this.workspace = workspace;
    const native = buildGuppyTools(this.config.workspaceManager);
    if (this.config.readOnly) {
      // Plan mode: expose only the provably read-only native tools. External
      // tools are excluded because their mutation behavior is unknown.
      this.tools = native.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));
    } else {
      this.tools = [...native, ...(this.config.extraTools ?? [])];
    }
  }

  async run(
    task: Task,
    context: Context,
    signal?: AbortSignal,
  ): Promise<Result<Trajectory, Error>> {
    if (!this.workspace) {
      return err(new Error('CoreAgentRuntime.initialize() must be called before run()'));
    }

    const workspaceId = this.workspace.id;
    const sessionId = context.sessionId || ulid();
    const startedAt = now();
    const events: Event[] = [];
    const emit = (event: Event): void => {
      events.push(event);
      this.config.eventStore.append(event);
    };

    emit({
      id: ulid(),
      timestamp: now(),
      type: 'TaskStarted',
      taskId: task.id,
      sessionId,
      payload: { task },
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(task, context) },
      { role: 'user', content: task.description },
    ];

    let tokensTotal = 0;
    let toolCalls = 0;
    const tokensByModel: Record<string, number> = {};
    let finished = false;
    let lastError = '';
    let finalAnswer = '';
    let cancelled = false;

    try {
      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        // The caller (Ctrl+C in chat) can stop the whole run between turns.
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        this.captureContext(messages, turn, startedAt);
        const callId = ulid();

        let completion: CompletionResult;
        if (this.config.stream) {
          // Throttle ModelStreamed emission so a long response doesn't flood
          // the event log — enough deltas for a watchable stream, not one per
          // network chunk.
          let lastStreamEmit = 0;
          completion = await this.client.completeStream(
            messages,
            this.tools.map((t) => t.definition),
            (text) => {
              const ms = Date.now();
              if (ms - lastStreamEmit >= 150) {
                lastStreamEmit = ms;
                emit({
                  id: ulid(),
                  timestamp: now(),
                  type: 'ModelStreamed',
                  taskId: task.id,
                  sessionId,
                  payload: { model: this.config.model.model, text, callId },
                });
              }
            },
            signal,
          );
        } else {
          completion = await this.client.complete(messages, this.tools.map((t) => t.definition), signal);
        }

        const delta = completion.usage.inputTokens + completion.usage.outputTokens;
        tokensTotal += delta;
        tokensByModel[completion.model] = (tokensByModel[completion.model] ?? 0) + delta;

        emit({
          id: ulid(),
          timestamp: now(),
          type: 'ModelCalled',
          taskId: task.id,
          sessionId,
          payload: {
            model: completion.model,
            promptTokens: completion.usage.inputTokens,
            completionTokens: completion.usage.outputTokens,
            callId,
          },
        });

        if (completion.toolCalls.length === 0) {
          finalAnswer = completion.content ?? '';
          if (finalAnswer) {
            emit({
              id: ulid(),
              timestamp: now(),
              type: 'FinalAnswer',
              taskId: task.id,
              sessionId,
              payload: { text: finalAnswer },
            });
          }
          finished = true;
          break;
        }

        messages.push({
          role: 'assistant',
          content: completion.content,
          tool_calls: completion.toolCalls,
        });

        for (const call of completion.toolCalls) {
          // Don't start a new tool after the caller aborted (Ctrl+C).
          if (signal?.aborted) {
            cancelled = true;
            break;
          }
          const tool = this.tools.find((t) => t.name === call.function.name);
          const args = parseArgs(call.function.arguments);
          const toolStart = Date.now();
          toolCalls++;

          emit({
            id: ulid(),
            timestamp: now(),
            type: 'ToolCalled',
            taskId: task.id,
            sessionId,
            payload: { tool: call.function.name, args, modelCallId: callId },
          });

          const execution: ToolExecution = tool
            ? await tool.execute(args, workspaceId)
            : { output: '', error: `unknown tool: ${call.function.name}` };

          emit({
            id: ulid(),
            timestamp: now(),
            type: 'ToolReturned',
            taskId: task.id,
            sessionId,
            payload: {
              tool: call.function.name,
              result: truncate(execution.output, MAX_TOOL_RESULT_CHARS),
              ...(execution.error ? { error: execution.error } : {}),
              duration: Date.now() - toolStart,
            },
          });

          const changedFiles =
            execution.filesChanged ?? (execution.fileChanged ? [execution.fileChanged] : []);
          for (const change of changedFiles) {
            emit({
              id: ulid(),
              timestamp: now(),
              type: 'FileChanged',
              taskId: task.id,
              sessionId,
              payload: {
                path: change.path,
                operation: change.operation,
              },
            });
          }

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: truncate(
              (execution.error ? `ERROR: ${execution.error}\n` : '') + execution.output,
              MAX_TOOL_RESULT_CHARS,
            ),
          });
        }
        // The model may have returned tool calls right as the caller aborted;
        // don't start the next turn's completion after a break.
        if (cancelled) break;
      }
    } catch (e) {
      if (e instanceof CancelledError || (signal?.aborted ?? false)) {
        cancelled = true;
      } else {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }

    const outcome: Trajectory['outcome'] = cancelled
      ? 'cancelled'
      : lastError
        ? 'failure'
        : finished
          ? 'success'
          : 'partial';
    const metrics: TrajectoryMetrics = {
      passes: 0,
      failures: 0,
      tokensTotal,
      tokensByModel,
      wallTimeMs: Date.now() - startedAt,
      toolCalls,
      checkpoints: 0,
      contextSelections: 0,
      verificationEscalations: 0,
    };

    emit({
      id: ulid(),
      timestamp: now(),
      type: 'TrajectoryCompleted',
      taskId: task.id,
      sessionId,
      payload: {
        outcome,
        metrics,
        lastGatePassed: outcome === 'success',
        ...(lastError ? { error: lastError } : {}),
        ...(finalAnswer ? { finalAnswer } : {}),
      },
    });

    if (lastError) {
      console.error(`[CoreAgentRuntime] run failed: ${lastError}`);
    } else if (cancelled) {
      console.log('[CoreAgentRuntime] run cancelled');
    }

    return ok({
      id: ulid(),
      taskId: task.id,
      sessionId,
      events: [...events].sort((a, b) => a.timestamp - b.timestamp),
      outcome,
      metrics,
      startedAt,
      completedAt: now(),
      ...(lastError ? { error: lastError } : {}),
      ...(finalAnswer ? { finalAnswer } : {}),
    });
  }

  async resume(checkpoint: Checkpoint): Promise<Result<Trajectory, Error>> {
    return err(
      new Error(`CoreAgentRuntime.resume() is not implemented yet (checkpoint ${checkpoint.id})`),
    );
  }

  async shutdown(): Promise<void> {
    // Nothing to release: the client is stateless and the workspace is owned
    // by the caller (SessionManager).
  }

  /**
   * Snapshot the payload about to hit the model, exactly as the API receives
   * it. The bench feeds these dumps to ContextOps to score context health
   * without replaying the run.
   */
  private captureContext(messages: ChatMessage[], turn: number, startedAt: Timestamp): void {
    const dir = this.config.contextCaptureDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const payload = {
        model: this.config.model.model,
        messages,
        tools: this.tools.map((t) => t.definition),
      };
      writeFileSync(join(dir, `turn-${startedAt}-${turn}.json`), JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      // Capture is best-effort telemetry — never fail the run over it.
      console.error(`[CoreAgentRuntime] context capture failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private buildSystemPrompt(task: Task, context: Context): string {
    const parts: string[] = [
      'You are Guppy, an autonomous software-engineering agent.',
      '',
      `TASK: ${task.description}`,
    ];

    if (context.files.length > 0) {
      parts.push('', '=== RELEVANT FILES (selected by the context engine) ===');
      for (const f of context.files) {
        parts.push(`--- ${f.path} ---`);
        parts.push(f.content);
      }
    }

    if (context.testResults.length > 0) {
      parts.push('', '=== CURRENT TEST RESULTS ===');
      for (const t of context.testResults) {
        parts.push(`- ${t.name}: ${t.status}`);
        if (t.output) parts.push(t.output);
      }
    }

    if (context.errors.length > 0) {
      parts.push('', '=== CURRENT ERRORS ===');
      for (const e of context.errors) {
        parts.push(`- ${e.file ? `${e.file}: ` : ''}${e.message}`);
      }
    }

    if (context.memories.length > 0) {
      parts.push('', '=== RELEVANT PAST EXPERIENCE ===');
      for (const m of context.memories) parts.push(`- ${m.summary}`);
    }

    if (context.skills.length > 0) {
      parts.push('', '=== SKILLS ===');
      for (const s of context.skills) {
        parts.push(`- ${s.name}: ${s.description}`);
        if (s.prompt) parts.push(s.prompt);
      }
    }

    parts.push(
      '',
      'Work in the current directory. Make minimal, focused changes.',
      'Use search, read_file, and list_files to explore; apply_patch (or write_file) to edit; git_status and git_diff to review changes; run_command to run tests.',
      'Verify your changes by running the tests before finishing.',
    );

    return parts.join('\n');
  }
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

export function createCoreRuntime(config: CoreRuntimeConfig): CoreAgentRuntime {
  return new CoreAgentRuntime(config);
}
