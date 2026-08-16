/**
 * Memory Store — persistent trajectory memory with failure-pattern retrieval
 *
 * Stage 1 scope (roadmap): "last time this test failed, fix was X".
 * Memories are stored as JSON lines under `.guppy/memory` and scored at
 * retrieval time by tag overlap, type match, and recency. No vector DB yet —
 * ADR: LanceDB only arrives in Stage 5 if query patterns demand it.
 */

import type {
  Memory,
  Trajectory,
  Event,
  ULID,
  Result,
} from '@guppy/contracts';
import { ulid, now, ok, err } from '@guppy/contracts';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MemoryStoreConfig {
  rootDir: string;
  /** Maximum memories returned by a single query */
  defaultLimit: number;
  /** Half-life in days for recency decay */
  recencyHalfLifeDays: number;
}

export interface MemoryQuery {
  /** Free-text terms matched against summary + tags */
  terms?: string[];
  tags?: string[];
  type?: Memory['type'];
  taskId?: ULID;
  limit?: number;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

const MEMORY_FILE = 'memories.jsonl';

export class MemoryStore {
  private config: MemoryStoreConfig;
  private cache: Memory[] | null = null;

  constructor(config: MemoryStoreConfig) {
    this.config = config;
    mkdirSync(config.rootDir, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------------

  record(memory: Omit<Memory, 'id' | 'createdAt'> & Partial<Pick<Memory, 'id' | 'createdAt'>>): Result<Memory, Error> {
    const full: Memory = {
      ...memory,
      id: memory.id ?? ulid(),
      createdAt: memory.createdAt ?? now(),
    };

    try {
      appendFileSync(this.filePath(), JSON.stringify(full) + '\n', 'utf-8');
      if (this.cache) this.cache.push(full);
      return ok(full);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Distill a completed trajectory into memories:
   * - one `trajectory` memory summarizing the run
   * - one `fix` memory per test/typecheck failure that later passed
   *   (the file changes between failure and pass are the candidate fix)
   */
  ingestTrajectory(trajectory: Trajectory): Result<Memory[], Error> {
    const created: Memory[] = [];

    const summary = this.record({
      type: 'trajectory',
      summary: `Task ${trajectory.taskId}: ${trajectory.outcome} in ${trajectory.metrics.wallTimeMs}ms, ` +
        `${trajectory.metrics.tokensTotal} tokens, ${trajectory.metrics.toolCalls} tool calls`,
      detail: {
        taskId: trajectory.taskId,
        sessionId: trajectory.sessionId,
        outcome: trajectory.outcome,
        metrics: trajectory.metrics,
      },
      tags: ['trajectory', trajectory.outcome],
      relevance: trajectory.outcome === 'success' ? 1.0 : 0.7,
      taskId: trajectory.taskId,
    });
    if (!summary.ok) return err(summary.error);
    created.push(summary.value);

    for (const fix of extractFixes(trajectory.events)) {
      const result = this.record({
        type: 'fix',
        summary: `Fix for "${fix.failureName}": changed ${fix.changedFiles.join(', ') || 'unknown files'}`,
        detail: fix,
        tags: ['fix', fix.failureKind, ...fix.changedFiles.map(basenameTag)],
        relevance: 1.0,
        taskId: trajectory.taskId,
      });
      if (result.ok) created.push(result.value);
    }

    return ok(created);
  }

  // ---------------------------------------------------------------------------
  // Read path
  // ---------------------------------------------------------------------------

  retrieve(query: MemoryQuery = {}): ScoredMemory[] {
    const limit = query.limit ?? this.config.defaultLimit;
    const memories = this.loadAll();
    const currentTime = now();
    const halfLifeMs = this.config.recencyHalfLifeDays * 24 * 60 * 60 * 1000;

    const scored: ScoredMemory[] = [];
    for (const memory of memories) {
      if (query.type && memory.type !== query.type) continue;
      if (query.taskId && memory.taskId !== query.taskId) continue;

      let score = memory.relevance;

      if (query.tags?.length) {
        const overlap = query.tags.filter((t) => memory.tags.includes(t)).length;
        if (overlap === 0) continue;
        score += overlap / query.tags.length;
      }

      if (query.terms?.length) {
        const haystack = (memory.summary + ' ' + memory.tags.join(' ')).toLowerCase();
        const hits = query.terms.filter((t) => haystack.includes(t.toLowerCase())).length;
        if (hits === 0 && !query.tags?.length) continue;
        score += hits / query.terms.length;
      }

      // Exponential recency decay
      const ageMs = currentTime - memory.createdAt;
      score *= Math.pow(0.5, ageMs / halfLifeMs);

      scored.push({ memory, score });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Convenience for the context engine: memories relevant to current errors */
  retrieveForFailure(failureName: string, limit = 3): ScoredMemory[] {
    return this.retrieve({
      type: 'fix',
      terms: tokenize(failureName),
      limit,
    });
  }

  count(): number {
    return this.loadAll().length;
  }

  /** Drop all memories (used by tests and the sleep cycle's re-ingest) */
  clear(): void {
    writeFileSync(this.filePath(), '', 'utf-8');
    this.cache = [];
  }

  private filePath(): string {
    return join(this.config.rootDir, MEMORY_FILE);
  }

  private loadAll(): Memory[] {
    if (this.cache) return this.cache;
    const path = this.filePath();
    if (!existsSync(path)) {
      this.cache = [];
      return this.cache;
    }

    const memories: Memory[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        memories.push(JSON.parse(line) as Memory);
      } catch {
        // Skip corrupt lines rather than failing the whole store
      }
    }
    this.cache = memories;
    return memories;
  }
}

// ---------------------------------------------------------------------------
// Trajectory distillation
// ---------------------------------------------------------------------------

export interface ExtractedFix {
  failureKind: 'test' | 'typecheck';
  failureName: string;
  failureMessage: string;
  changedFiles: string[];
}

/**
 * Scan a trajectory's events for failure → file changes → pass sequences.
 * The files changed between a failure and the next matching pass are the
 * candidate fix for that failure.
 */
export function extractFixes(events: Event[]): ExtractedFix[] {
  const fixes: ExtractedFix[] = [];
  // Open failures by name, each accumulating file changes until resolved
  const open = new Map<string, ExtractedFix>();

  for (const event of events) {
    switch (event.type) {
      case 'TestFailed': {
        const name = event.payload.name;
        open.set(`test:${name}`, {
          failureKind: 'test',
          failureName: name,
          failureMessage: event.payload.output ?? '',
          changedFiles: [],
        });
        break;
      }
      case 'TypecheckFailed': {
        for (const e of event.payload.errors) {
          open.set(`typecheck:${e.file}`, {
            failureKind: 'typecheck',
            failureName: e.file,
            failureMessage: e.message,
            changedFiles: [],
          });
        }
        break;
      }
      case 'FileChanged': {
        for (const fix of open.values()) {
          if (!fix.changedFiles.includes(event.payload.path)) {
            fix.changedFiles.push(event.payload.path);
          }
        }
        break;
      }
      case 'TestPassed': {
        const key = `test:${event.payload.name}`;
        const fix = open.get(key);
        if (fix && fix.changedFiles.length > 0) {
          fixes.push(fix);
          open.delete(key);
        }
        break;
      }
      case 'TypecheckPassed': {
        for (const [key, fix] of open) {
          if (key.startsWith('typecheck:') && fix.changedFiles.length > 0) {
            fixes.push(fix);
            open.delete(key);
          }
        }
        break;
      }
    }
  }

  return fixes;
}

function tokenize(text: string): string[] {
  return text
    .split(/[^a-zA-Z0-9_]+/)
    .filter((t) => t.length > 2)
    .slice(0, 8);
}

function basenameTag(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryStore(config: Partial<MemoryStoreConfig> = {}): MemoryStore {
  const defaultConfig: MemoryStoreConfig = {
    rootDir: join(process.cwd(), '.guppy', 'memory'),
    defaultLimit: 10,
    recencyHalfLifeDays: 30,
    ...config,
  };
  return new MemoryStore(defaultConfig);
}
