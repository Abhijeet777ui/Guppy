/**
 * Prime Transcript Parser
 *
 * Pure parser for prime-agent's `--mode json` JSONL event stream
 * (see prime-agent/packages/coding-agent/docs/json.md). Kept free of
 * process/IO concerns so it can be unit-tested against recorded
 * transcripts.
 *
 * Stream shape:
 *   line 1: {"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
 *   then:   agent_start / turn_start / message_start / message_update /
 *           message_end / tool_execution_start / tool_execution_end /
 *           turn_end / agent_end
 */

import type { Event, Timestamp, TrajectoryMetrics, ULID } from '@guppy/contracts';
import { now, ulid } from '@guppy/contracts';

export interface PrimeSessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

/** Loose typing — we parse defensively across prime-agent versions. */
export interface PrimeJsonEvent {
  type: string;
  [key: string]: unknown;
}

/** Tools whose execution mutates files in the workspace. */
const FILE_WRITE_TOOL = /write|edit|patch|apply|create|replace|move|delete/i;
const PATH_ARG_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'targetFile'] as const;

function extractPath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function extractUsage(message: unknown): { model: string; input: number; output: number } {
  const msg = (message ?? {}) as Record<string, any>;
  const rawModel = msg['model'];
  const model =
    typeof rawModel === 'string'
      ? rawModel
      : typeof rawModel?.['id'] === 'string'
        ? rawModel['id']
        : 'unknown';
  const usage = msg['usage'] ?? {};
  return {
    model,
    input: Number(usage['input'] ?? usage['promptTokens'] ?? 0) || 0,
    output: Number(usage['output'] ?? usage['completionTokens'] ?? 0) || 0,
  };
}

export class PrimeTranscriptParser {
  private readonly taskId: ULID;
  private readonly sessionId: ULID;
  private readonly events: Event[] = [];
  /** toolCallId -> start metadata, so tool_execution_end can attribute the path. */
  private readonly toolStarts = new Map<string, { startedAt: Timestamp; args: unknown }>();

  sessionHeader: PrimeSessionHeader | null = null;
  sawAgentEnd = false;
  assistantMessages = 0;
  /** Tail of unparseable lines, for diagnostics. */
  readonly malformedLines: string[] = [];

  constructor(taskId: ULID, sessionId: ULID) {
    this.taskId = taskId;
    this.sessionId = sessionId;
  }

  /**
   * Feed one raw JSONL line. Returns true if the line produced an event
   * (or was the session header), false if blank/malformed/ignored.
   */
  feedLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;

    let evt: PrimeJsonEvent;
    try {
      evt = JSON.parse(trimmed) as PrimeJsonEvent;
    } catch {
      if (this.malformedLines.length < 50) this.malformedLines.push(trimmed);
      return false;
    }
    if (typeof evt?.type !== 'string') return false;

    this.handle(evt);
    return true;
  }

  getEvents(): Event[] {
    return this.events;
  }

  /**
   * Derive the trajectory outcome from the process exit code and the
   * observed stream. Task-level success is decided later by the
   * VerificationEngine — this only reports runtime completion.
   */
  determineOutcome(exitCode: number | null): 'success' | 'failure' | 'partial' {
    if (exitCode === 0 && this.sawAgentEnd) return 'success';
    if (this.events.length > 1) return 'partial';
    return 'failure';
  }

  calculateMetrics(): TrajectoryMetrics {
    return computeMetrics(this.events);
  }

  private handle(evt: PrimeJsonEvent): void {
    switch (evt.type) {
      case 'session':
        this.sessionHeader = evt as unknown as PrimeSessionHeader;
        return;

      case 'message_start': {
        const msg = evt['message'] as Record<string, unknown> | undefined;
        if (msg?.['role'] === 'assistant') this.assistantMessages++;
        return;
      }

      case 'message_end': {
        const msg = evt['message'] as Record<string, unknown> | undefined;
        if (msg?.['role'] !== 'assistant') return;
        const { model, input, output } = extractUsage(msg);
        this.emit({
          type: 'ModelCalled',
          payload: { model, promptTokens: input, completionTokens: output, callId: ulid() },
        });
        return;
      }

      case 'tool_execution_start': {
        const toolCallId = String(evt['toolCallId'] ?? '');
        this.toolStarts.set(toolCallId, { startedAt: now(), args: evt['args'] });
        this.emit({
          type: 'ToolCalled',
          payload: { tool: String(evt['toolName'] ?? 'unknown'), args: evt['args'], modelCallId: toolCallId as ULID },
        });
        return;
      }

      case 'tool_execution_end': {
        const toolCallId = String(evt['toolCallId'] ?? '');
        const toolName = String(evt['toolName'] ?? 'unknown');
        const start = this.toolStarts.get(toolCallId);
        this.toolStarts.delete(toolCallId);
        const isError = Boolean(evt['isError']);

        this.emit({
          type: 'ToolReturned',
          payload: {
            tool: toolName,
            result: summarizeResult(evt['result']),
            ...(isError ? { error: summarizeResult(evt['result']) } : {}),
            duration: start ? Date.now() - start.startedAt : 0,
          },
        });

        // Surface file mutations as first-class events for the
        // verification engine and replay tooling. The path lives on the
        // *start* event: prime-agent's tool_execution_end carries no `args`.
        if (FILE_WRITE_TOOL.test(toolName)) {
          const path = extractPath(start?.args);
          if (path) {
            this.emit({
              type: 'FileChanged',
              payload: { path, operation: /create/i.test(toolName) ? 'create' : 'modify' },
            });
          }
        }
        return;
      }

      case 'agent_end':
        this.sawAgentEnd = true;
        return;

      default:
        // turn_start / turn_end / message_update / session_action_update /
        // compaction_* / auto_retry_* — not mapped to Guppy events yet.
        return;
    }
  }

  private emit(partial: { type: Event['type']; payload: unknown }): void {
    this.events.push({
      id: ulid(),
      timestamp: now(),
      type: partial.type,
      taskId: this.taskId,
      sessionId: this.sessionId,
      payload: partial.payload,
    } as Event);
  }
}

/** Keep tool results bounded in the event log. */
function summarizeResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
  return text.length > 2000 ? `${text.slice(0, 2000)}…[truncated]` : text;
}

/** Shared metrics computation over a Guppy event sequence. */
export function computeMetrics(events: Event[]): TrajectoryMetrics {
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

  for (const e of events) {
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

  if (events.length > 1) {
    metrics.wallTimeMs = events[events.length - 1]!.timestamp - events[0]!.timestamp;
  }

  return metrics;
}
