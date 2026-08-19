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
import type { ChatMessage, CompletionResult, ToolCall } from './openai-client.js';
import type { ModelConfig } from './model.js';
import { CancelledError, OpenAIChatClient } from './openai-client.js';
import { buildGuppyTools, READ_ONLY_TOOL_NAMES, type GuppyTool, type ToolExecution } from './tools.js';
import {
  createSubagentBridge,
  createSubagentTool,
  DEFAULT_SUBAGENT_CHILD_MAX_TURNS,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  DEFAULT_SUBAGENT_VERIFICATION_TIMEOUT_MS,
  type SubagentBridge,
} from './subagent.js';
import {
  COMPRESSED_HISTORY_HEADER,
  compressMessages,
  estimateMessageTokens,
  type CompressionResult,
} from './compress.js';

/** Default history budget (estimated tokens) before the recap kicks in. */
const DEFAULT_MAX_HISTORY_TOKENS = 60_000;
/**
 * Default number of most-recent model turns kept verbatim after a compression.
 * 2 (not 6): the 2026-08-19 A/B showed keep-6 exempted ~6 turns from the budget
 * and made compression *cost* tokens on re-read-heavy tasks (STATUS bug #17).
 */
const DEFAULT_HISTORY_KEEP_RECENT_TURNS = 2;

/** Optional LLM summarization of the compressed history (hybrid recap). */
export interface HistorySummarizerConfig {
  /** Model for the summary call; defaults to the main model. */
  model?: ModelConfig;
  /** Max chars of the older turns sent to the summarizer (default 40_000). */
  maxInputChars?: number;
  /** Max completion tokens for the summary (default 1000). */
  maxSummaryTokens?: number;
}

const SUMMARIZER_SYSTEM_PROMPT =
  'Summarize the following agent conversation history into a compact recap for a coding agent that is about to continue the same task. Preserve: the original task, decisions made, key findings (file names, function names, error messages, test results), what has been tried and its result, what remains to be done, and the latest state of any file that was read or edited. Be concise and factual; do not invent details that are not in the transcript.';

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
  /**
   * Long-horizon guard: when the estimated conversation-history tokens exceed
   * this budget, the older turns are replaced by a compact recap (the most
   * recent `historyKeepRecentTurns` stay verbatim). Default 60_000; 0 disables.
   */
  maxHistoryTokens?: number;
  /** Model turns kept verbatim when history compression fires. Default 2. */
  historyKeepRecentTurns?: number;
  /**
   * Optional LLM summarization of the compressed history (hybrid recap). When
   * set, each compression replaces the deterministic recap body with a compact
   * semantic summary from a summarizer model, falling back to the deterministic
   * recap on any error. Off by default — deterministic-only is the offline,
   * zero-cost floor.
   */
  historySummarizer?: HistorySummarizerConfig;
  /**
   * Enables the recursive `subagent` tool (prime's RLM idea, native): the
   * model can spawn a child agent on a sub-task with its own event-store
   * trace, its own turn budget, and its own verification gate, then fold the
   * result back into this turn. Children share this runtime's workspace, so
   * their changes are physically present when the tool returns. `maxDepth`
   * bounds how many levels of children may be spawned (default 3); children
   * never inherit extra/MCP tools and are hermetic by construction.
   */
  subagent?: {
    /** Max nested child levels below this runtime (default 3; 0 = no tool). */
    maxDepth?: number;
    /** Default child turn budget (default 6; a call may lower it, never raise). */
    childMaxTurns?: number;
    /** Timeout for the child's verification gate in ms (default 300_000). */
    childVerificationTimeoutMs?: number;
  };
}

const MAX_TOOL_RESULT_CHARS = 20_000;

export class CoreAgentRuntime implements AgentRuntime {
  private readonly config: CoreRuntimeConfig;
  private readonly client: OpenAIChatClient;
  private workspace: Workspace | null = null;
  private tools: GuppyTool[] = [];
  /**
   * Per-run bridge the subagent tool reads (task/context/signal) and emits
   * through (AgentForked/AgentMerged land in this trajectory too). Filled in
   * by run(); a child runtime gets its own bridge.
   */
  private readonly subagentBridge: SubagentBridge;

  constructor(config: CoreRuntimeConfig) {
    this.config = config;
    this.client = new OpenAIChatClient(config.model);
    this.subagentBridge = createSubagentBridge();
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
      // Recursive subagent tool (opt-in): children spawn with depth-1, so the
      // tree terminates at maxDepth. The child gate is the contract.
      const subagentCfg = this.config.subagent;
      if (subagentCfg) {
        const subagent = createSubagentTool({
          eventStore: this.config.eventStore,
          workspaceManager: this.config.workspaceManager,
          model: this.config.model,
          workspace,
          maxDepth: subagentCfg.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH,
          childMaxTurns: subagentCfg.childMaxTurns ?? DEFAULT_SUBAGENT_CHILD_MAX_TURNS,
          childVerificationTimeoutMs:
            subagentCfg.childVerificationTimeoutMs ?? DEFAULT_SUBAGENT_VERIFICATION_TIMEOUT_MS,
          bridge: this.subagentBridge,
        });
        if (subagent) this.tools.push(subagent);
      }
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

    const sessionId = context.sessionId || ulid();
    const trajectoryId = ulid();
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

    // Persist a full-context resume cursor for this attempt so a hard crash
    // mid-conversation can be resumed at the turn level (best-effort).
    await this.saveRuntimeCheckpoint(trajectoryId, context, sessionId);

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(task, context) },
      { role: 'user', content: task.description },
    ];

    return ok(
      await this.executeLoop({
        task,
        context,
        sessionId,
        trajectoryId,
        signal,
        startedAt,
        events,
        emit,
        messages,
        startTurn: 0,
        tokensTotal: 0,
        tokensByModel: {},
        toolCalls: 0,
        compressions: 0,
      }),
    );
  }

  async resume(checkpoint: Checkpoint, signal?: AbortSignal): Promise<Result<Trajectory, Error>> {
    if (!this.workspace) {
      return err(new Error('CoreAgentRuntime.initialize() must be called before resume()'));
    }

    const taskId = checkpoint.taskId;
    const sessionId = checkpoint.sessionId;

    // Replay the session log to reconstruct the exact model-visible
    // conversation and the accumulated turn/counter state.
    const events: Event[] = [];
    for await (const event of this.config.eventStore.readEvents({ taskId, sessionId, index: 0 })) {
      events.push(event);
    }

    if (events.some((e) => e.type === 'TrajectoryCompleted')) {
      return err(new Error(`Session ${sessionId} already completed; nothing to resume`));
    }

    const taskStarted = events.find((e) => e.type === 'TaskStarted');
    const task = taskStarted ? (taskStarted.payload as { task: Task }).task : undefined;
    if (!task) {
      return err(new Error(`Session ${sessionId} has no TaskStarted event; cannot resume`));
    }

    const reconstruction = this.reconstructConversation(events, task, checkpoint.context);

    const trajectoryId = checkpoint.trajectoryId || ulid();
    const startedAt = events[0]?.timestamp ?? now();
    const resumeEvents: Event[] = [];
    const emit = (event: Event): void => {
      resumeEvents.push(event);
      this.config.eventStore.append(event);
    };

    return ok(
      await this.executeLoop({
        task,
        context: checkpoint.context,
        sessionId,
        trajectoryId,
        signal,
        startedAt,
        events: resumeEvents,
        emit,
        messages: reconstruction.messages,
        startTurn: reconstruction.turnsCompleted,
        tokensTotal: reconstruction.tokensTotal,
        tokensByModel: reconstruction.tokensByModel,
        toolCalls: reconstruction.toolCalls,
        compressions: reconstruction.compressions,
      }),
    );
  }

  /**
   * The shared model↔tool loop. `run()` starts a fresh conversation; `resume()`
   * continues an interrupted one from a reconstructed message list, turn
   * offset, and counters. Both funnel through here so the loop, the event
   * stream, and the trajectory assembly behave identically.
   */
  private async executeLoop(params: {
    task: Task;
    context: Context;
    sessionId: ULID;
    trajectoryId: ULID;
    signal: AbortSignal | undefined;
    startedAt: Timestamp;
    events: Event[];
    emit: (event: Event) => void;
    messages: ChatMessage[];
    startTurn: number;
    tokensTotal: number;
    tokensByModel: Record<string, number>;
    toolCalls: number;
    compressions: number;
  }): Promise<Trajectory> {
    const {
      task,
      sessionId,
      trajectoryId,
      signal,
      startedAt,
      events,
      emit,
      messages,
      startTurn,
    } = params;
    const workspaceId = this.workspace!.id;
    let tokensTotal = params.tokensTotal;
    let toolCalls = params.toolCalls;
    let compressions = params.compressions;
    const tokensByModel: Record<string, number> = { ...params.tokensByModel };

    // Publish this run to the subagent bridge so a spawned child inherits
    // the parent's abort signal, task, and context (and its AgentForked /
    // AgentMerged events flow through THIS trajectory's emit).
    this.subagentBridge.emit = emit;
    this.subagentBridge.signal = signal ?? null;
    this.subagentBridge.task = task;
    this.subagentBridge.context = params.context;

    let finished = false;
    let lastError = '';
    let finalAnswer = '';
    let cancelled = false;

    try {
      for (let turn = startTurn; turn < this.config.maxTurns; turn++) {
        // The caller (Ctrl+C in chat) can stop the whole run between turns.
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        // Long-horizon guard: once the history exceeds the budget, replace the
        // older turns with a recap so the model window is never blown.
        const compressed = await this.maybeCompressHistory(messages, task.id, sessionId, signal);
        if (compressed) {
          compressions++;
          if (compressed.summary) {
            const delta = compressed.summary.inputTokens + compressed.summary.outputTokens;
            tokensTotal += delta;
            tokensByModel[compressed.summary.model] = (tokensByModel[compressed.summary.model] ?? 0) + delta;
          }
          emit(compressed.event);
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

        // Log the model-visible assistant message so resume() can reconstruct
        // the exact conversation from the event log (the "model-visible ⟺
        // logged" invariant).
        emit({
          id: ulid(),
          timestamp: now(),
          type: 'AssistantMessage',
          taskId: task.id,
          sessionId,
          payload: {
            content: completion.content,
            toolCalls: completion.toolCalls.map((c) => ({
              id: c.id,
              name: c.function.name,
              arguments: c.function.arguments,
            })),
            callId,
          },
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
              toolCallId: call.id,
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
      ...(compressions > 0 ? { compressions } : {}),
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

    // Never leave a stale run's task/context/signal in the bridge.
    this.subagentBridge.emit = null;
    this.subagentBridge.signal = null;
    this.subagentBridge.task = null;
    this.subagentBridge.context = null;

    return {
      id: trajectoryId,
      taskId: task.id,
      sessionId,
      events: [...events].sort((a, b) => a.timestamp - b.timestamp),
      outcome,
      metrics,
      startedAt,
      completedAt: now(),
      ...(lastError ? { error: lastError } : {}),
      ...(finalAnswer ? { finalAnswer } : {}),
    };
  }

  /**
   * Reconstruct the model-visible conversation from a session's events, up to
   * the last COMPLETE turn (an assistant message whose every tool call has a
   * returned result). A trailing partial turn — a crash mid-tool-execution —
   * is dropped rather than replayed, because the model requires a tool result
   * for every tool call it issued.
   */
  private reconstructConversation(
    events: Event[],
    task: Task,
    context: Context,
  ): {
    messages: ChatMessage[];
    turnsCompleted: number;
    tokensTotal: number;
    tokensByModel: Record<string, number>;
    toolCalls: number;
    compressions: number;
  } {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(task, context) },
      { role: 'user', content: task.description },
    ];

    let turnsCompleted = 0;
    let tokensTotal = 0;
    const tokensByModel: Record<string, number> = {};
    let toolCalls = 0;
    let compressions = 0;

    // An assistant turn awaiting its tool results (null between turns).
    let pending: {
      content: string | null;
      toolCalls: ToolCall[];
      results: Map<string, ChatMessage>;
    } | null = null;

    for (const event of events) {
      switch (event.type) {
        case 'ModelCalled': {
          const p = event.payload as { model: string; promptTokens: number; completionTokens: number };
          tokensTotal += p.promptTokens + p.completionTokens;
          tokensByModel[p.model] = (tokensByModel[p.model] ?? 0) + p.promptTokens + p.completionTokens;
          break;
        }
        case 'ContextCompressed': {
          compressions++;
          const p = event.payload as { summaryTokens?: number };
          if (p.summaryTokens) tokensTotal += p.summaryTokens;
          break;
        }
        case 'AssistantMessage': {
          const p = event.payload as {
            content: string | null;
            toolCalls: Array<{ id: string; name: string; arguments: string }>;
          };
          if (p.toolCalls.length === 0) break;
          pending = {
            content: p.content,
            toolCalls: p.toolCalls.map((c) => ({
              id: c.id,
              function: { name: c.name, arguments: c.arguments },
            })),
            results: new Map(),
          };
          break;
        }
        case 'ToolCalled':
          toolCalls++;
          break;
        case 'ToolReturned': {
          const p = event.payload as { tool: string; result: unknown; error?: string; toolCallId?: string };
          if (pending && p.toolCallId) {
            pending.results.set(p.toolCallId, {
              role: 'tool',
              tool_call_id: p.toolCallId,
              name: p.tool,
              // Mirrors the loop's exact model-visible tool message. The one
              // lossy edge is a result already truncated to MAX plus an error
              // prefix, where re-truncation clips slightly differently.
              content: truncate(
                (p.error ? `ERROR: ${p.error}\n` : '') + String(p.result ?? ''),
                MAX_TOOL_RESULT_CHARS,
              ),
            });
          }
          break;
        }
      }

      // Commit a turn only once every tool call it issued has a result.
      const p = pending;
      if (p && p.toolCalls.every((c) => p.results.has(c.id))) {
        messages.push({ role: 'assistant', content: p.content, tool_calls: p.toolCalls });
        for (const c of p.toolCalls) {
          messages.push(p.results.get(c.id)!);
        }
        pending = null;
        turnsCompleted++;
      }
    }

    return { messages, turnsCompleted, tokensTotal, tokensByModel, toolCalls, compressions };
  }

  /**
   * Persist a resume cursor (a full-context event-store snapshot) so a hard
   * crash mid-attempt can be resumed at the turn level. Best-effort: a failed
   * snapshot never breaks the run — attempt-level resume still applies.
   */
  private async saveRuntimeCheckpoint(
    trajectoryId: ULID,
    context: Context,
    sessionId: ULID,
  ): Promise<void> {
    try {
      // eventIndex is informational for resume (it reconstructs from the full
      // session log), so 0 is fine here.
      const result = await this.config.eventStore.createSnapshot(trajectoryId, 0, context, 'pre_tool');
      if (!result.ok) {
        console.warn(`[CoreAgentRuntime] Resume cursor not saved: ${result.error.message}`);
      }
    } catch (e) {
      console.warn(`[CoreAgentRuntime] Resume cursor failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async shutdown(): Promise<void> {
    // Nothing to release: the client is stateless and the workspace is owned
    // by the caller (SessionManager).
  }

  /**
   * Long-horizon guard: if the estimated history is over budget, compress the
   * older turns into a recap (mutating `messages` in place). With the optional
   * summarizer enabled, the deterministic recap body is then replaced by a
   * semantic LLM summary (falling back to the deterministic recap on error).
   * Returns the `ContextCompressed` event for the caller to emit, plus any
   * summarizer usage to fold into the trajectory's token totals.
   */
  private async maybeCompressHistory(
    messages: ChatMessage[],
    taskId: ULID,
    sessionId: ULID,
    signal?: AbortSignal,
  ): Promise<{
    event: Event;
    summary?: { model: string; inputTokens: number; outputTokens: number };
  } | null> {
    const budget = this.config.maxHistoryTokens ?? DEFAULT_MAX_HISTORY_TOKENS;
    if (budget <= 0) return null;
    const before = messages.length;
    const tokensBefore = estimateMessageTokens(messages.slice(1));
    if (tokensBefore <= budget) return null;

    const result = compressMessages(messages, {
      maxHistoryTokens: budget,
      keepRecentTurns: this.config.historyKeepRecentTurns ?? DEFAULT_HISTORY_KEEP_RECENT_TURNS,
    });
    if (result.compressedTurns === 0) return null;

    messages.length = 0;
    messages.push(...result.messages);

    let summarySource: 'deterministic' | 'llm' = 'deterministic';
    let summary: { model: string; inputTokens: number; outputTokens: number } | undefined;
    if (this.config.historySummarizer) {
      try {
        const s = await this.summarizeHistory(result, signal);
        if (s) {
          summary = { model: s.model, inputTokens: s.inputTokens, outputTokens: s.outputTokens };
          if (s.text !== '') {
            messages[1] = { role: 'system', content: `${COMPRESSED_HISTORY_HEADER} (LLM summary)\n\n${s.text}` };
            summarySource = 'llm';
          }
        }
      } catch {
        // The deterministic recap is the fallback; compression already succeeded.
      }
    }

    const tokensAfter = estimateMessageTokens(messages);
    const summaryTokens = summary ? summary.inputTokens + summary.outputTokens : 0;
    console.log(
      `[CoreAgentRuntime] compressed ${result.compressedTurns} turn(s) of history (${result.tokensBefore} -> ${tokensAfter} est. tokens, ${summarySource}${summaryTokens > 0 ? `, +${summaryTokens} summary tok` : ''})`,
    );
    return {
      event: {
        id: ulid(),
        timestamp: now(),
        type: 'ContextCompressed',
        taskId,
        sessionId,
        payload: {
          turnsCompressed: result.compressedTurns,
          messagesBefore: before,
          messagesAfter: messages.length,
          tokensBefore: result.tokensBefore,
          tokensAfter,
          summarySource,
          ...(summaryTokens > 0 ? { summaryTokens } : {}),
        },
      },
      ...(summary ? { summary } : {}),
    };
  }

  /**
   * One LLM call turning the compressed turns into a semantic recap. Returns
   * the summary text + usage, or null when the summarizer produced no text.
   */
  private async summarizeHistory(
    result: CompressionResult,
    signal?: AbortSignal,
  ): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number } | null> {
    const cfg = this.config.historySummarizer!;
    const modelConfig: ModelConfig = {
      ...(cfg.model ?? this.config.model),
      ...(cfg.maxSummaryTokens !== undefined ? { maxTokens: cfg.maxSummaryTokens } : { maxTokens: 1_000 }),
    };
    const client = new OpenAIChatClient(modelConfig);
    const transcript = buildSummarizerTranscript(result.older, cfg.maxInputChars ?? 40_000);
    const completion = await client.complete(
      [
        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      undefined,
      signal,
    );
    return {
      text: completion.content?.trim() ?? '',
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
    };
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

/**
 * Render the compressed turns as a flat transcript for the summarizer, capped
 * at `maxChars` so a run full of big tool results can't blow the summarizer's
 * own context window.
 */
function buildSummarizerTranscript(older: ChatMessage[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const message of older) {
    let line = '';
    if (message.role === 'user') {
      line = `USER: ${message.content ?? ''}`;
    } else if (message.role === 'assistant') {
      line =
        message.tool_calls && message.tool_calls.length > 0
          ? `ASSISTANT ran: ${message.tool_calls
              .map((c) => `${c.function.name}(${truncate(c.function.arguments, 200)})`)
              .join('; ')}`
          : `ASSISTANT: ${message.content ?? ''}`;
    } else if (message.role === 'tool') {
      line = `TOOL ${message.name ?? ''}: ${message.content ?? ''}`;
    } else {
      continue;
    }
    if (used + line.length > maxChars) {
      parts.push(`${line.slice(0, Math.max(0, maxChars - used))}…[truncated]`);
      break;
    }
    parts.push(line);
    used += line.length + 1;
  }
  return parts.join('\n');
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
