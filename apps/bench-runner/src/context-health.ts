/**
 * ContextOps bridge — deterministic context-health scoring for the bench.
 *
 * The core runtime can dump the exact `{ model, messages, tools }` payload it
 * sends to the model (see CoreAgentRuntime.contextCaptureDir). This module
 * feeds those dumps to ContextOps — the embedding-free structural linter for
 * LLM context — and aggregates a per-run Context Health Score.
 *
 * ContextOps is a Python package, so this bridge shells out to `python -c`.
 * It is strictly best-effort: if Python or ContextOps is unavailable, the
 * bench still works and the report just omits the score (never fails a run).
 */

import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One scored capture file. */
export interface CaptureAnalysis {
  file: string;
  score: number;
  ciStatus: string;
  totalTokens: number;
  wastedTokens: number;
  totalPenalty: number;
  /** Estimated tokens reclaimable by applying ContextOps' findings (total × estimated_reduction_pct). */
  tokensSaved: number;
  /** "contextops@x.y.z" — the version that produced this analysis. */
  tool: string;
}

/** Aggregated health across all captured payloads of one config+task. */
export interface ContextHealthSummary {
  files: number;
  scoreMin: number;
  scoreMax: number;
  scoreAvg: number;
  ciStatus: string;
  totalTokens: number;
  wastedTokens: number;
  /** Estimated tokens reclaimable across captures (total × estimated_reduction_pct). */
  tokensSaved: number;
  /** Scoring tool + version, e.g. "contextops@0.3.4". */
  tool?: string;
  /** Set when scoring was not possible (missing python/contextops or no captures). */
  skipped?: boolean;
  reason?: string;
}

/**
 * Compact Python program: read a capture file, run ContextOps, print only the
 * fields the bench cares about as a single JSON line on stdout. stderr is left
 * untouched (the Python 3.14 pydantic warning goes there).
 */
const CONTEXTOPS_SCRIPT = [
  'import json, sys',
  'from contextops.api.inspect import inspect_context',
  'def _norm(v):',
  '    if isinstance(v, dict):',
  '        return {k: ("" if (k == "content" and vv is None) else _norm(vv)) for k, vv in v.items()}',
  '    if isinstance(v, list):',
  '        return [_norm(x) for x in v]',
  '    return v',
  'payload = _norm(json.load(open(sys.argv[1], encoding="utf-8")))',
  'r = inspect_context(payload, model="gpt-4o", archetype="agent")',
  'd = r.to_dict()',
  'tb = d.get("token_breakdown") or {}',
  'sb = d.get("score_breakdown") or {}',
  'try:',
  '    from importlib.metadata import version as _ctxv',
  '    _ver = _ctxv("contextops")',
  'except Exception:',
  '    _ver = "unknown"',
  'out = {',
  '  "score": d.get("score"),',
  '  "ci_status": d.get("ci_status"),',
  '  "total_tokens": tb.get("total_tokens", 0),',
  '  "wasted_tokens": tb.get("wasted_tokens", 0),',
  '  "reduction_pct": tb.get("estimated_reduction_pct", 0),',
  '  "total_penalty": sb.get("total_penalty", 0),',
  '  "tool": f"contextops@{_ver}",',
  '}',
  'print(json.dumps(out))',
].join('\n');

/** Score one capture file by invoking ContextOps through `python -c`. */
export function analyzeCaptureFile(file: string, python: string, timeoutMs = 30_000): Promise<CaptureAnalysis> {
  return new Promise((resolve, reject) => {
    execFile(python, ['-c', CONTEXTOPS_SCRIPT, file], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || '').trim().split('\n').filter((l) => !/Warning|pydantic/i.test(l)).slice(-1)[0] || error.message;
        reject(new Error(detail));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const totalTokens = Number(parsed.total_tokens ?? 0);
        const reductionPct = Number(parsed.reduction_pct ?? 0);
        resolve({
          file,
          score: Number(parsed.score),
          ciStatus: String(parsed.ci_status ?? 'UNKNOWN'),
          totalTokens,
          wastedTokens: Number(parsed.wasted_tokens ?? 0),
          totalPenalty: Number(parsed.total_penalty ?? 0),
          tokensSaved: Math.round((totalTokens * reductionPct) / 100),
          tool: String(parsed.tool ?? 'contextops@unknown'),
        });
      } catch (e) {
        reject(new Error(`unparseable contextops output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

const CI_RANK: Record<string, number> = { PASS: 0, WARN: 1, FAIL: 2, UNKNOWN: 3 };

function worstCiStatus(items: CaptureAnalysis[]): string {
  let worst = 'PASS';
  for (const item of items) {
    if ((CI_RANK[item.ciStatus] ?? 3) > (CI_RANK[worst] ?? 3)) worst = item.ciStatus;
  }
  return worst;
}

/** Pure aggregation — testable without Python. */
export function aggregateCaptures(items: CaptureAnalysis[]): ContextHealthSummary {
  if (items.length === 0) {
    return {
      files: 0,
      scoreMin: 0,
      scoreMax: 0,
      scoreAvg: 0,
      ciStatus: 'n/a',
      totalTokens: 0,
      wastedTokens: 0,
      tokensSaved: 0,
    };
  }
  const scores = items.map((i) => i.score);
  const tool = items[0]?.tool;
  return {
    files: items.length,
    scoreMin: Math.min(...scores),
    scoreMax: Math.max(...scores),
    scoreAvg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
    ciStatus: worstCiStatus(items),
    totalTokens: items.reduce((a, b) => a + b.totalTokens, 0),
    wastedTokens: items.reduce((a, b) => a + b.wastedTokens, 0),
    tokensSaved: items.reduce((a, b) => a + b.tokensSaved, 0),
    ...(tool ? { tool } : {}),
  };
}

/**
 * Score every capture in a directory. Returns `null` when there is nothing to
 * score, and a summary with `skipped: true` when scoring is impossible (e.g.
 * Python or ContextOps not installed) — the first failure bails out rather
 * than spawning N doomed subprocesses.
 */
export async function analyzeContextCaptures(dir: string, python = 'python'): Promise<ContextHealthSummary | null> {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const items: CaptureAnalysis[] = [];
  for (const file of files) {
    try {
      items.push(await analyzeCaptureFile(join(dir, file), python));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ...aggregateCaptures(items), files: files.length, skipped: true, reason };
    }
  }
  return aggregateCaptures(items);
}

/**
 * Attach a ContextHealthSummary to every bench result that produced captured
 * payloads. Takes structural (duck-typed) arguments so this module stays free
 * of a runtime import cycle with runner.ts.
 */
export async function attachContextHealth(
  results: Array<{ config: string; taskId: string; contextHealth?: ContextHealthSummary }>,
  options: { outDir: string; contextOpsPython?: string },
): Promise<void> {
  const python = options.contextOpsPython ?? 'python';
  for (const result of results) {
    const dir = join(options.outDir, 'context', result.config, result.taskId);
    const health = await analyzeContextCaptures(dir, python);
    if (health) result.contextHealth = health;
  }
}
