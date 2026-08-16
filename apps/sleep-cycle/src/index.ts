/**
 * Guppy Sleep Cycle — offline learning.
 *
 * Reads every trajectory from the event store, clusters recurring failures
 * deterministically, and produces a markdown report with candidate fixes
 * pulled from the memory store. Runs entirely offline (v1); pi-ai-driven
 * distillation is a later upgrade.
 */

import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { now } from '@guppy/contracts';
import { createEventStore, type EventStore } from '@guppy/event-store';
import { createMemoryStore, type MemoryStore } from '@guppy/memory';
import { replayAllSessions, sessionSummaries, type SessionRecord } from './replay.js';
import { clusterSessions } from './cluster.js';
import { renderReport, matchCandidateFixes, type SleepCycleReport } from './report.js';

export interface AnalyzeOptions {
  /** Event store root directory (default `.guppy/events` under cwd). */
  eventsRootDir?: string;
  /** Memory store root directory (default `.guppy/memory` under cwd). */
  memoryRootDir?: string;
  /** Write the rendered report to this path (default `.guppy/sleep-cycle/report.md`). */
  outPath?: string;
}

export interface AnalyzeResult {
  report: SleepCycleReport;
  markdown: string;
  outPath: string;
}

/**
 * Bench runs use one event store per task (`events/<config>/<taskId>`), so a
 * root like `.guppy/bench/<run>/events` is not itself a store. Discover every
 * store root underneath (any dir holding `index.db`), bounded in depth.
 */
function discoverStoreRoots(root: string, depth = 0): string[] {
  if (existsSync(join(root, 'index.db'))) return [root];
  if (depth >= 4) return [];
  const roots: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const child = join(root, entry);
    try {
      if (existsSync(join(child, 'index.db'))) {
        roots.push(child);
      } else {
        roots.push(...discoverStoreRoots(child, depth + 1));
      }
    } catch {
      // Unreadable entries are skipped — analysis must never crash on scratch dirs.
    }
  }
  return roots;
}

/**
 * Full sleep-cycle pass: replay -> cluster -> match memory fixes -> render.
 * Accepts pre-built stores (tests) or builds them from the given roots.
 */
export async function runSleepCycle(
  options: AnalyzeOptions = {},
  stores?: { eventStore: EventStore; memoryStore: MemoryStore },
): Promise<AnalyzeResult> {
  const memoryStore =
    stores?.memoryStore ??
    createMemoryStore(options.memoryRootDir ? { rootDir: options.memoryRootDir } : {});

  const eventStores: EventStore[] = [];
  if (stores?.eventStore) {
    eventStores.push(stores.eventStore);
  } else {
    const root = options.eventsRootDir ?? join(process.cwd(), '.guppy', 'events');
    const roots = discoverStoreRoots(root);
    if (roots.length > 0) {
      for (const storeRoot of roots) eventStores.push(createEventStore({ rootDir: storeRoot }));
    } else {
      // Nothing recorded yet — open the root itself so the report renders an
      // empty-but-valid state instead of crashing.
      eventStores.push(createEventStore(options.eventsRootDir ? { rootDir: options.eventsRootDir } : {}));
    }
  }

  const records: SessionRecord[] = [];
  const summaries = [];
  for (const eventStore of eventStores) {
    records.push(...(await replayAllSessions(eventStore)));
    summaries.push(...sessionSummaries(eventStore));
  }
  const clusters = clusterSessions(records);
  const report: SleepCycleReport = {
    generatedAt: now(),
    sessionCount: records.length,
    clusters,
    candidateFixes: matchCandidateFixes(clusters, memoryStore),
    sessions: summaries,
  };

  const markdown = renderReport(report);
  const outPath = options.outPath ?? join(process.cwd(), '.guppy', 'sleep-cycle', 'report.md');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf-8');

  for (const eventStore of eventStores) {
    await eventStore.close();
  }

  return { report, markdown, outPath };
}

export { replayAllSessions, sessionSummaries } from './replay.js';
export type { SessionRecord } from './replay.js';
export { clusterSessions } from './cluster.js';
export type { FailureCluster } from './cluster.js';
export { renderReport, matchCandidateFixes } from './report.js';
export type { SleepCycleReport } from './report.js';
