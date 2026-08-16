/**
 * Sleep Cycle — deterministic failure clustering.
 *
 * Groups TestFailed/TypecheckFailed events across all replayed sessions by a
 * normalized signature, and ranks clusters by recurrence. The files changed
 * between a failure and its resolution (via @guppy/memory's extractFixes)
 * become the cluster's candidate fix locations. No LLM — v1 is pure counting.
 */

import type { ULID } from '@guppy/contracts';
import { extractFixes } from '@guppy/memory';
import type { SessionRecord } from './replay.js';

export interface FailureCluster {
  /** Stable key: `${kind}:${normalizedName}` */
  signature: string;
  kind: 'test' | 'typecheck';
  name: string;
  /** First observed failure message, truncated. */
  sampleMessage: string;
  /** Total failure events across all sessions. */
  occurrences: number;
  sessionIds: ULID[];
  taskIds: ULID[];
  /** Candidate fix locations: file -> times it was changed while this failure was open. */
  filesChanged: Record<string, number>;
  /** True if at least one session resolved this failure (a later pass event). */
  everResolved: boolean;
}

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    // Collapse varying line numbers, hex ids and durations so the same
    // logical failure clusters together across runs.
    .replace(/:\d+(:\d+)?/g, '')
    .replace(/\b\d+(\.\d+)?\s*m?s\b/g, '')
    .replace(/\s+/g, ' ');
}

export function clusterSessions(records: SessionRecord[]): FailureCluster[] {
  const clusters = new Map<string, FailureCluster>();

  // A failure, its fix, and the passing re-run usually land in *different*
  // sessions (one session per attempt). Compute fixes per task across all of
  // the task's sessions, otherwise extractFixes never sees the
  // failure -> change -> pass sequence and every cluster reports unresolved.
  const recordsByTask = new Map<string, SessionRecord[]>();
  for (const record of records) {
    const list = recordsByTask.get(record.taskId) ?? [];
    list.push(record);
    recordsByTask.set(record.taskId, list);
  }

  for (const taskRecords of recordsByTask.values()) {
    const fixes = extractFixes(
      taskRecords
        .flatMap((r) => r.trajectory.events)
        .sort((a, b) => a.timestamp - b.timestamp),
    );
    const fixesByName = new Map(fixes.map((fix) => [normalizeName(fix.failureName), fix]));

    for (const { taskId, sessionId, trajectory } of taskRecords) {
      for (const event of trajectory.events) {
        let kind: FailureCluster['kind'] | null = null;
        let name = '';
        let message = '';

        if (event.type === 'TestFailed') {
          kind = 'test';
          name = event.payload.name ?? 'unknown test';
          message = event.payload.output ?? '';
        } else if (event.type === 'TypecheckFailed') {
          kind = 'typecheck';
          const first = event.payload.errors[0];
          name = first?.file ?? 'typecheck';
          message = first?.message ?? '';
        }
        if (!kind) continue;

        const signature = `${kind}:${normalizeName(name)}`;
        let cluster = clusters.get(signature);
        if (!cluster) {
          cluster = {
            signature,
            kind,
            name,
            sampleMessage: message.slice(0, 300),
            occurrences: 0,
            sessionIds: [],
            taskIds: [],
            filesChanged: {},
            everResolved: false,
          };
          clusters.set(signature, cluster);
        }

        cluster.occurrences++;
        if (!cluster.sessionIds.includes(sessionId)) cluster.sessionIds.push(sessionId);
        if (!cluster.taskIds.includes(taskId)) cluster.taskIds.push(taskId);

        const fix = fixesByName.get(normalizeName(name));
        if (fix) {
          cluster.everResolved = true;
          for (const file of fix.changedFiles) {
            cluster.filesChanged[file] = (cluster.filesChanged[file] ?? 0) + 1;
          }
        }
      }
    }
  }

  return [...clusters.values()].sort(
    (a, b) => b.occurrences - a.occurrences || b.sessionIds.length - a.sessionIds.length,
  );
}
