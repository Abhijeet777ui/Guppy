/**
 * Sleep Cycle — replay.
 *
 * Reconstructs Trajectory records from the event store's append-only log.
 * Deterministic: no LLM involved; this is the substrate the clusterer and
 * report generator consume.
 */

import type { Trajectory, ULID } from '@guppy/contracts';
import type { EventStore, SessionSummary } from '@guppy/event-store';

export interface SessionRecord {
  taskId: ULID;
  sessionId: ULID;
  trajectory: Trajectory;
}

/**
 * Replay every session under every task in the store. Sessions whose log
 * cannot be decoded are skipped (a corrupt session must not break the whole
 * sleep cycle).
 */
export async function replayAllSessions(eventStore: EventStore): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];

  for (const taskId of eventStore.listTasks()) {
    const sessions = await eventStore.listSessions(taskId as ULID);
    for (const sessionId of sessions) {
      const trajectory = await eventStore.getTrajectory(taskId as ULID, sessionId);
      if (!trajectory) continue;
      records.push({ taskId: taskId as ULID, sessionId, trajectory });
    }
  }

  return records;
}

/** Index-backed per-session summaries (tokens, tool calls, outcome). */
export function sessionSummaries(eventStore: EventStore): SessionSummary[] {
  return eventStore.listSessionSummaries();
}
