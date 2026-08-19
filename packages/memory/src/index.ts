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
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface MemoryStoreConfig {
  rootDir: string;
  /** Maximum memories returned by a single query */
  defaultLimit: number;
  /** Half-life in days for recency decay */
  recencyHalfLifeDays: number;
  /**
   * Optional per-user global store (e.g. `~/.guppy/memory`) layered under the
   * primary. `fix` memories are written to both; reads merge both with the
   * primary winning id collisions — so a fix distilled in one repo is
   * retrievable in another (the memory counterpart of `~/.guppy/skills`).
   */
  secondaryRootDir?: string;
  /**
   * Fixes at or above this relevance are mirrored into the per-user global
   * store; weaker attributions stay repo-local so garbage correlations
   * (e.g. a flaky test's failure coinciding with an unrelated edit) don't
   * follow the user across repos. Distilled fixes carry
   * `relevance = extractFixes` confidence.
   */
  globalMirrorConfidence: number;
}

/** Per-user global memory dir; override with `GUPPY_MEMORY_DIR` (hermetic tests, CI). */
export function defaultMemoryDir(): string {
  return process.env['GUPPY_MEMORY_DIR'] ?? join(homedir(), '.guppy', 'memory');
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
  /** Layered global store for cross-repo `fix` memories (optional). */
  private secondary: MemoryStore | null = null;

  constructor(config: MemoryStoreConfig) {
    this.config = config;
    mkdirSync(config.rootDir, { recursive: true });
    if (config.secondaryRootDir) {
      // The secondary never gets its own secondary (no recursion), and it
      // shares the primary's scoring defaults so merged scores are comparable.
      this.secondary = new MemoryStore({
        rootDir: config.secondaryRootDir,
        defaultLimit: config.defaultLimit,
        recencyHalfLifeDays: config.recencyHalfLifeDays,
        globalMirrorConfidence: config.globalMirrorConfidence,
      });
    }
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
      // Fixes are the cross-repo asset: mirror them into the global store
      // with the same id so a later repo can retrieve them (primary wins on
      // dedupe). Only confident fixes propagate — low-relevance attributions
      // stay repo-local so garbage correlations don't poison other repos.
      // Trajectory summaries stay local — noise across repos.
      if (full.type === 'fix' && this.secondary && full.relevance >= this.config.globalMirrorConfidence) {
        const mirrored = this.secondary.record(full);
        if (!mirrored.ok) return err(mirrored.error);
      }
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
        // Evidence strength doubles as relevance: ambiguous attributions
        // rank low and stay out of the global cross-repo store.
        relevance: fix.confidence,
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
    // Merge this store's candidates with the global store's, deduping by id
    // (primary wins) so a fix mirrored into both never appears twice.
    const byId = new Map<string, ScoredMemory>();
    for (const scored of this.scoreAll(query)) {
      byId.set(scored.memory.id, scored);
    }
    if (this.secondary) {
      for (const scored of this.secondary.scoreAll(query)) {
        if (!byId.has(scored.memory.id)) byId.set(scored.memory.id, scored);
      }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Filter + score one store's memories (no limit — the caller merges). */
  private scoreAll(query: MemoryQuery): ScoredMemory[] {
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

    return scored;
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
    // Unique ids across layers — a fix mirrored into the global store counts once.
    const ids = new Set<string>();
    for (const m of this.loadAll()) ids.add(m.id);
    if (this.secondary) {
      for (const m of this.secondary.loadAll()) ids.add(m.id);
    }
    return ids.size;
  }

  /** Drop all memories in both layers (used by tests and re-ingest) */
  clear(): void {
    writeFileSync(this.filePath(), '', 'utf-8');
    this.cache = [];
    this.secondary?.clear();
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
  /**
   * Evidence strength that the changed files explain the pass, 0..1:
   * base 0.5 for any change between failure and pass, +0.25 for a single
   * changed file, +0.25 when every contributing change happened while this
   * was the only open failure, -0.15 when four or more files changed.
   * Deterministic — no LLM in learning.
   */
  confidence: number;
}

/** An open fix plus the ambiguity observed at each contributing change. */
interface OpenFix extends ExtractedFix {
  /** How many failures were open when each contributing change happened. */
  openCountsAtChange: number[];
}

/**
 * Scan a trajectory's events for failure → file changes → pass sequences.
 * The files changed between a failure and the next matching pass are the
 * candidate fix for that failure. Every change is attributed to all open
 * failures (a shared helper can fix several), but the confidence score
 * dilutes when several failures were open concurrently or many files
 * changed — the attribution is ambiguous there.
 */
export function extractFixes(events: Event[]): ExtractedFix[] {
  const fixes: ExtractedFix[] = [];
  // Open failures by name, each accumulating file changes until resolved
  const open = new Map<string, OpenFix>();

  for (const event of events) {
    switch (event.type) {
      case 'TestFailed': {
        const name = event.payload.name;
        open.set(`test:${name}`, {
          failureKind: 'test',
          failureName: name,
          failureMessage: event.payload.output ?? '',
          changedFiles: [],
          confidence: 0,
          openCountsAtChange: [],
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
            confidence: 0,
            openCountsAtChange: [],
          });
        }
        break;
      }
      case 'FileChanged': {
        const openCount = open.size;
        for (const fix of open.values()) {
          if (!fix.changedFiles.includes(event.payload.path)) {
            fix.changedFiles.push(event.payload.path);
            fix.openCountsAtChange.push(openCount);
          }
        }
        break;
      }
      case 'TestPassed': {
        const key = `test:${event.payload.name}`;
        const fix = open.get(key);
        if (fix && fix.changedFiles.length > 0) {
          fixes.push(closeFix(fix));
          open.delete(key);
        }
        break;
      }
      case 'TypecheckPassed': {
        for (const [key, fix] of open) {
          if (key.startsWith('typecheck:') && fix.changedFiles.length > 0) {
            fixes.push(closeFix(fix));
            open.delete(key);
          }
        }
        break;
      }
    }
  }

  return fixes;
}

/** Score a resolved fix's evidence strength (see ExtractedFix.confidence). */
function closeFix(fix: OpenFix): ExtractedFix {
  let confidence = 0.5;
  if (fix.changedFiles.length === 1) confidence += 0.25;
  if (fix.openCountsAtChange.every((c) => c === 1)) confidence += 0.25;
  if (fix.changedFiles.length >= 4) confidence -= 0.15;
  const { openCountsAtChange, ...rest } = fix;
  return { ...rest, confidence: Math.max(0, Math.min(1, confidence)) };
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
    globalMirrorConfidence: 0.7,
    ...config,
  };
  return new MemoryStore(defaultConfig);
}
