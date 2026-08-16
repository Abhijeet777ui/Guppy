/**
 * SQLite Index — queryable sidecar for the append-only event log
 *
 * The msgpack event files remain the source of truth; this index exists
 * so `guppy trace`, the bench runner, and the sleep cycle can answer
 * "which sessions exist, what happened, how much did they cost" without
 * scanning every event file. Rebuildable from the log at any time.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Event, ULID } from '@guppy/contracts';

const nodeRequire = createRequire(import.meta.url);

/**
 * Lazily load node:sqlite so the event store still works (log-only, no
 * index) on runtimes without the built-in module.
 */
function loadDatabaseSync(): (typeof DatabaseSyncType) | null {
  try {
    const mod = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
    return mod.DatabaseSync;
  } catch {
    return null;
  }
}

export interface SessionSummary {
  taskId: string;
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
  eventCount: number;
  tokensTotal: number;
  toolCalls: number;
}

export interface EventIndexConfig {
  /** Path of the SQLite database file. */
  dbPath: string;
}

export class EventIndex {
  private db: DatabaseSyncType;

  constructor(config: EventIndexConfig) {
    const DatabaseSync = loadDatabaseSync();
    if (!DatabaseSync) {
      throw new Error('node:sqlite is not available in this runtime');
    }
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        task_id     TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        started_at  INTEGER,
        ended_at    INTEGER,
        outcome     TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        tool_calls  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id   TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        timestamp  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(task_id, session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    `);
  }

  /** Open (insert-if-missing) the session row. */
  beginSession(taskId: ULID, sessionId: ULID, startedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO sessions (task_id, session_id, started_at)
         VALUES (?, ?, ?)
         ON CONFLICT(task_id, session_id) DO NOTHING`
      )
      .run(taskId, sessionId, startedAt);
  }

  /** Index one appended event and fold its counters into the session row. */
  indexEvent(event: Event, seq: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (event_id, task_id, session_id, seq, type, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(event.id, event.taskId, event.sessionId, seq, event.type, event.timestamp);

    let tokenDelta = 0;
    let toolDelta = 0;
    if (event.type === 'ModelCalled') {
      const payload = event.payload as { promptTokens: number; completionTokens: number };
      tokenDelta = (payload.promptTokens ?? 0) + (payload.completionTokens ?? 0);
    } else if (event.type === 'ToolCalled') {
      toolDelta = 1;
    }

    this.db
      .prepare(
        `UPDATE sessions
         SET event_count = event_count + 1,
             tokens_total = tokens_total + ?,
             tool_calls = tool_calls + ?
         WHERE task_id = ? AND session_id = ?`
      )
      .run(tokenDelta, toolDelta, event.taskId, event.sessionId);
  }

  /** Record terminal outcome for a session. */
  finalizeSession(taskId: ULID, sessionId: ULID, endedAt: number, outcome: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET ended_at = ?, outcome = ?
         WHERE task_id = ? AND session_id = ?`
      )
      .run(endedAt, outcome, taskId, sessionId);
  }

  /** Purge all index rows for a task (pairs with EventStore.deleteTask). */
  deleteTask(taskId: string): void {
    this.db.prepare('DELETE FROM events WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM sessions WHERE task_id = ?').run(taskId);
  }

  listTasks(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT task_id FROM sessions ORDER BY started_at')
      .all() as Array<{ task_id: string }>;
    return rows.map((r) => r.task_id);
  }

  listSessions(taskId?: string): SessionSummary[] {
    const statement = taskId
      ? this.db.prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at')
      : this.db.prepare('SELECT * FROM sessions ORDER BY started_at');
    const rows = (taskId ? statement.all(taskId) : statement.all()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      taskId: String(r['task_id']),
      sessionId: String(r['session_id']),
      startedAt: Number(r['started_at'] ?? 0),
      endedAt: r['ended_at'] === null ? null : Number(r['ended_at']),
      outcome: r['outcome'] === null ? null : String(r['outcome']),
      eventCount: Number(r['event_count'] ?? 0),
      tokensTotal: Number(r['tokens_total'] ?? 0),
      toolCalls: Number(r['tool_calls'] ?? 0),
    }));
  }

  /** Event-type histogram for a session — cheap replay-free triage. */
  eventTypeCounts(taskId: string, sessionId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM events
         WHERE task_id = ? AND session_id = ? GROUP BY type ORDER BY n DESC`
      )
      .all(taskId, sessionId) as Array<{ type: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.type] = row.n;
    return counts;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Create the index, degrading gracefully when node:sqlite is unavailable
 * (e.g. Node < 22.5). The event log itself keeps working either way.
 */
export function createEventIndex(config: EventIndexConfig): EventIndex | null {
  try {
    return new EventIndex(config);
  } catch (e) {
    console.warn(
      '[EventIndex] SQLite unavailable, continuing without the query index:',
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}
