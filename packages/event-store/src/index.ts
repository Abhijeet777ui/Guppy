/**
 * Event Store — Append-only event log with snapshots and deterministic replay
 */

import type {
  Event,
  Trajectory,
  Checkpoint,
  Snapshot,
  Task,
  Context,
  ULID,
  Timestamp,
  Result,
} from '@guppy/contracts';
import { ulid, now, ok, err } from '@guppy/contracts';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, decode, decodeMultiStream } from '@msgpack/msgpack';
import { createEventIndex, type EventIndex, type SessionSummary } from './sqlite-index.js';

export { EventIndex, createEventIndex } from './sqlite-index.js';
export type { SessionSummary, EventIndexConfig } from './sqlite-index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface EventStoreConfig {
  rootDir: string;
  snapshotInterval: number;
  maxEventsPerFile: number;
  /** Maintain a SQLite query index beside the log (default true). */
  sqliteIndex: boolean;
}

export interface EventCursor {
  taskId: ULID;
  sessionId: ULID;
  index: number;
}

export interface ReplayOptions {
  fromCheckpoint?: Checkpoint;
  fromIndex?: number;
  filter?: (event: Event) => boolean;
}

export class EventStore {
  private config: EventStoreConfig;
  private fd: number | null = null;
  private currentFilePath: string | null = null;
  private currentFileEventCount = 0;
  private taskId: ULID | null = null;
  private sessionId: ULID | null = null;
  private eventIndex = 0;
  private fileSequence = 0;
  private index: EventIndex | null = null;
  /** Whether the active session already got its terminal outcome. */
  private currentSessionFinalized = false;
  /** Live listeners notified on every append (TUI, telemetry, demos). */
  private listeners = new Set<(event: Event) => void>();

  constructor(config: EventStoreConfig) {
    this.config = config;
    mkdirSync(config.rootDir, { recursive: true });
    if (config.sqliteIndex) {
      this.index = createEventIndex({ dbPath: join(config.rootDir, 'index.db') });
    }
  }

  beginSession(taskId: ULID, sessionId: ULID): void {
    this.taskId = taskId;
    this.sessionId = sessionId;
    this.eventIndex = 0;
    this.currentSessionFinalized = false;
    this.index?.beginSession(taskId, sessionId, Date.now());
    this.rotateFile();
  }

  async endSession(): Promise<void> {
    this.closeFile();
  }

  /** Flush the event log and close the SQLite index handle (process shutdown). */
  async close(): Promise<void> {
    this.closeFile();
    this.index?.close();
    this.index = null;
  }

  /**
   * Register a live listener for every event appended to the store. Returns an
   * unsubscribe function. Listeners fire synchronously after the event is
   * persisted; a throwing listener is isolated so it can never break a run.
   */
  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  append(event: Event): Result<void, Error> {
    // Auto-manage session lifecycle from the event's own identity so
    // callers that don't drive beginSession (runtimes, verification engine,
    // bench runner) still get a complete log and index.
    if (event.taskId !== this.taskId || event.sessionId !== this.sessionId) {
      // The previous session is ending without a TrajectoryCompleted (crash, or
      // a runtime that switched sessions mid-stream). Finalize its index row so
      // it doesn't linger open; a session that already finalized keeps its real
      // outcome.
      if (this.taskId && this.sessionId && !this.currentSessionFinalized) {
        this.index?.finalizeSession(this.taskId, this.sessionId, Date.now(), 'unknown');
      }
      this.eventIndex = 0;
      this.taskId = event.taskId;
      this.sessionId = event.sessionId;
      this.currentSessionFinalized = false;
      this.index?.beginSession(event.taskId, event.sessionId, Date.now());
      this.rotateFile();
    }

    const enrichedEvent: Event = {
      ...event,
      id: event.id || ulid(),
      timestamp: event.timestamp || now(),
      taskId: this.taskId,
      sessionId: this.sessionId,
    };

    try {
      this.writeEvent(enrichedEvent);
      this.index?.indexEvent(enrichedEvent, this.eventIndex);
      this.eventIndex++;

      // Notify live subscribers (best-effort: never break the run over a
      // listener or renderer failure).
      for (const listener of this.listeners) {
        try {
          listener(enrichedEvent);
        } catch (e) {
          console.error('[EventStore] Listener error:', e);
        }
      }

      if (enrichedEvent.type === 'TrajectoryCompleted') {
        const payload = enrichedEvent.payload as { outcome?: string };
        this.index?.finalizeSession(this.taskId, this.sessionId, Date.now(), payload.outcome ?? 'unknown');
        this.currentSessionFinalized = true;
      }

      if (this.currentFileEventCount >= this.config.maxEventsPerFile) {
        this.rotateFile();
      }

      if (this.eventIndex % this.config.snapshotInterval === 0) {
        this.createPeriodicSnapshot(enrichedEvent).catch((e) => console.error('[EventStore] Snapshot error:', e));
      }

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private writeEvent(event: Event): void {
    if (this.fd === null) {
      this.rotateFile();
    }

    // Msgpack frames are self-delimiting; decodeMultiStream reads them back
    // without length prefixes. Synchronous writeSync means there is no stream
    // backpressure to drop, and the event is durable before append() returns
    // (and before live listeners fire).
    const data = encode(event);
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let written = 0;
    while (written < buf.length) {
      const n = writeSync(this.fd!, buf, written, buf.length - written);
      if (n <= 0) throw new Error('event log write failed');
      written += n;
    }
    this.currentFileEventCount++;
  }

  private rotateFile(): void {
    this.closeFile();

    const date = new Date().toISOString().replace(/[:.]/g, '-');
    // Zero-padded sequence keeps lexicographic filename order == write order.
    const filename = `events-${this.taskId}-${this.sessionId}-${date}-${String(this.fileSequence).padStart(6, '0')}.msgpack`;
    this.fileSequence++;
    this.currentFilePath = join(this.config.rootDir, this.taskId!, this.sessionId!, filename);

    mkdirSync(dirname(this.currentFilePath), { recursive: true });
    this.fd = openSync(this.currentFilePath, 'a');
    this.currentFileEventCount = 0;
  }

  private closeFile(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  async createSnapshot(
    trajectoryId: ULID,
    eventIndex: number,
    context: Context,
    reason: Checkpoint['reason']
  ): Promise<Result<Checkpoint, Error>> {
    if (!this.taskId || !this.sessionId) {
      return err(new Error('No active session'));
    }

    try {
      const snapshotId = ulid();
      const snapshotDir = join(this.config.rootDir, 'snapshots', this.taskId, this.sessionId);
      mkdirSync(snapshotDir, { recursive: true });

      const snapshotPath = join(snapshotDir, `${snapshotId}.msgpack`);
      const snapshot: Snapshot = {
        id: snapshotId,
        workspaceId: ulid(),
        fsSnapshotPath: snapshotPath,
        createdAt: now(),
        size: 0,
      };

      const checkpoint: Checkpoint = {
        id: ulid(),
        taskId: this.taskId,
        sessionId: this.sessionId,
        trajectoryId,
        eventIndex,
        snapshotId,
        context,
        createdAt: now(),
        reason,
      };

      // Persist the checkpoint (context included) so `guppy resume` can
      // load it after a crash or process restart
      const checkpointData = encode(checkpoint);
      writeFileSync(snapshotPath, Buffer.from(checkpointData.buffer, checkpointData.byteOffset, checkpointData.byteLength));
      snapshot.size = checkpointData.byteLength;

      this.append({
        id: ulid(),
        timestamp: now(),
        type: 'CheckpointCreated',
        taskId: this.taskId,
        sessionId: this.sessionId,
        payload: {
          checkpointId: checkpoint.id,
          snapshotId,
          reason,
        },
      } as Event);

      return ok(checkpoint);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async createPeriodicSnapshot(event: Event): Promise<void> {
    if (!this.taskId || !this.sessionId) return;

    // Lightweight checkpoint: a msgpack Checkpoint record carrying the event
    // cursor. Replay from this point only needs the log itself, so no context
    // dump is required — the context field holds a minimal cursor placeholder.
    try {
      const snapshotDir = join(this.config.rootDir, 'snapshots', this.taskId, this.sessionId);
      mkdirSync(snapshotDir, { recursive: true });

      const checkpoint: Checkpoint = {
        id: ulid(),
        taskId: this.taskId,
        sessionId: this.sessionId,
        trajectoryId: event.id,
        eventIndex: this.eventIndex,
        snapshotId: ulid(),
        context: {
          taskId: this.taskId,
          sessionId: this.sessionId,
          files: [],
          testResults: [],
          errors: [],
          memories: [],
          skills: [],
          tokensUsed: 0,
          maxTokens: 0,
          selectedAt: now(),
          selectionReasoning: 'periodic checkpoint cursor (event log is the source of truth)',
        },
        createdAt: now(),
        reason: 'periodic',
      };

      const data = encode(checkpoint);
      writeFileSync(
        join(snapshotDir, `${checkpoint.id}.msgpack`),
        Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      );
    } catch (e) {
      // A failed periodic snapshot must never break the event stream.
      console.error('[EventStore] Periodic snapshot failed:', e);
    }
  }

  /** All persisted checkpoints for a session, oldest first. Works without an active session. */
  listCheckpoints(taskId: ULID, sessionId: ULID): Checkpoint[] {
    const snapshotDir = join(this.config.rootDir, 'snapshots', taskId, sessionId);
    if (!existsSync(snapshotDir)) return [];

    const checkpoints: Checkpoint[] = [];
    for (const file of readdirSync(snapshotDir).filter((f: string) => f.endsWith('.msgpack'))) {
      try {
        checkpoints.push(decode(readFileSync(join(snapshotDir, file))) as Checkpoint);
      } catch (e) {
        console.error(`[EventStore] Corrupt checkpoint ${file}:`, e);
      }
    }
    return checkpoints.sort((a, b) => a.createdAt - b.createdAt);
  }

  getLatestCheckpoint(taskId: ULID, sessionId: ULID): Checkpoint | null {
    const checkpoints = this.listCheckpoints(taskId, sessionId);
    return checkpoints[checkpoints.length - 1] ?? null;
  }

  async *readEvents(cursor: EventCursor, options: ReplayOptions = {}): AsyncGenerator<Event> {
    // Honor the cursor's own index; an explicit fromIndex still wins.
    const { fromIndex, filter } = options;
    const startFrom = fromIndex ?? cursor.index ?? 0;
    const eventDir = join(this.config.rootDir, cursor.taskId, cursor.sessionId);

    if (!existsSync(eventDir)) {
      return;
    }

    const files = readdirSync(eventDir)
      .filter((f: string) => f.startsWith('events-') && f.endsWith('.msgpack'))
      .sort();

    let globalIndex = 0;

    for (const file of files) {
      const filePath = join(eventDir, file);
      const stream = createReadStream(filePath);

      for await (const event of this.parseEventStream(stream)) {
        if (globalIndex < startFrom) {
          globalIndex++;
          continue;
        }

        if (!filter || filter(event)) {
          yield event;
        }
        globalIndex++;
      }
    }
  }

  private async *parseEventStream(stream: NodeJS.ReadableStream): AsyncGenerator<Event> {
    const webStream = Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    try {
      for await (const event of decodeMultiStream(webStream)) {
        yield event as Event;
      }
    } catch (e) {
      console.error('[EventStore] Failed to decode event stream:', e);
    }
  }

  async getTrajectory(taskId: ULID, sessionId: ULID): Promise<Trajectory | null> {
    const events: Event[] = [];
    for await (const event of this.readEvents({ taskId, sessionId, index: 0 })) {
      events.push(event);
    }

    if (events.length === 0) return null;

    const completedEvent = events.find((e) => e.type === 'TrajectoryCompleted');
    const outcome = completedEvent ? (completedEvent.payload as Record<string, unknown>)['outcome'] as Trajectory['outcome'] : 'running';

    return {
      id: ulid(),
      taskId,
      sessionId,
      events,
      outcome,
      metrics: this.calculateMetrics(events),
      startedAt: events[0]?.timestamp ?? now(),
      completedAt: completedEvent?.timestamp ?? now(),
    };
  }

  private calculateMetrics(events: Event[]): Trajectory['metrics'] {
    const metrics: Trajectory['metrics'] = {
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

    for (const event of events) {
      switch (event.type) {
        case 'TestPassed':
          metrics.passes++;
          break;
        case 'TestFailed':
          metrics.failures++;
          break;
        case 'ModelCalled': {
          const payload = event.payload as { model: string; promptTokens: number; completionTokens: number };
          metrics.tokensTotal += payload.promptTokens + payload.completionTokens;
          metrics.tokensByModel[payload.model] = (metrics.tokensByModel[payload.model] ?? 0) + payload.promptTokens + payload.completionTokens;
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
      const firstEvent = events[0]!;
      const lastEvent = events[events.length - 1]!;
      metrics.wallTimeMs = lastEvent.timestamp - firstEvent.timestamp;
    }

    return metrics;
  }

  async listSessions(taskId: ULID): Promise<ULID[]> {
    const taskDir = join(this.config.rootDir, taskId);
    if (!existsSync(taskDir)) return [];
    return readdirSync(taskDir).filter((f: string) => !f.startsWith('.')) as ULID[];
  }

  /** All tasks known to the index, oldest first. */
  listTasks(): string[] {
    return this.index?.listTasks() ?? [];
  }

  /** Index-backed session summaries (tokens, tools, outcome) without replay. */
  listSessionSummaries(taskId?: ULID): SessionSummary[] {
    return this.index?.listSessions(taskId) ?? [];
  }

  /** Index-backed event-type histogram for a session. */
  eventTypeCounts(taskId: ULID, sessionId: ULID): Record<string, number> {
    return this.index?.eventTypeCounts(taskId, sessionId) ?? {};
  }

  async deleteTask(taskId: ULID): Promise<void> {
    const taskDir = join(this.config.rootDir, taskId);
    if (existsSync(taskDir)) {
      rmSync(taskDir, { recursive: true, force: true });
    }
    // Keep the query index consistent with the log, otherwise deleted tasks
    // keep showing up in listTasks()/listSessions().
    this.index?.deleteTask(taskId);
  }
}

export function createEventStore(config: Partial<EventStoreConfig> = {}): EventStore {
  const defaultConfig: EventStoreConfig = {
    rootDir: join(process.cwd(), '.guppy', 'events'),
    snapshotInterval: 100,
    maxEventsPerFile: 10000,
    sqliteIndex: true,
    ...config,
  };
  return new EventStore(defaultConfig);
}