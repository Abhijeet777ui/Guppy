/**
 * Guppy Bench — reporting.
 *
 * Emits report.md (pass-rate/token/latency comparison) and results.json
 * (raw per-attempt data) under the run's outDir.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  effectiveRetrySettings,
  type BenchConfigKind,
  type BenchOptions,
  type TaskRunResult,
} from './runner.js';

export interface ConfigSummary {
  config: BenchConfigKind;
  total: number;
  passed: number;
  passRate: number;
  tokensTotal: number;
  avgWallTimeMs: number;
  toolCallsTotal: number;
}

export function summarize(results: TaskRunResult[], config: BenchConfigKind): ConfigSummary {
  const rows = results.filter((r) => r.config === config);
  const passed = rows.filter((r) => r.passed).length;
  const wallSum = rows.reduce((acc, r) => acc + r.wallTimeMs, 0);
  return {
    config,
    total: rows.length,
    passed,
    passRate: rows.length === 0 ? 0 : passed / rows.length,
    tokensTotal: rows.reduce((acc, r) => acc + r.tokensTotal, 0),
    avgWallTimeMs: rows.length === 0 ? 0 : Math.round(wallSum / rows.length),
    toolCallsTotal: rows.reduce((acc, r) => acc + r.toolCalls, 0),
  };
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '-';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

function cell(result: TaskRunResult | undefined): string {
  if (!result) return '-';
  const mark = result.passed ? 'PASS' : 'FAIL';
  return `${mark} (${result.attempts.length}a, ${result.tokensTotal} tok)`;
}

export function renderReport(results: TaskRunResult[], options: BenchOptions): string {
  const lines: string[] = [];
  const configs = options.configs;

  lines.push('# Guppy Bench Report');
  lines.push('');
  const retry = effectiveRetrySettings(options);

  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Model: ${options.model}`);
  lines.push(`- Configs: ${configs.join(', ')}`);
  lines.push(`- Max attempts per task: ${options.maxAttempts}`);
  lines.push(
    `- Retries (guppy-core): ${retry.maxRetries} (base ${retry.baseDelayMs}ms, max ${retry.maxDelayMs}ms)`,
  );
  lines.push(`- Dry run: ${options.dryRun ? 'yes' : 'no'}`);
  lines.push('');

  // --- Summary ---------------------------------------------------------------
  lines.push('## Summary');
  lines.push('');
  lines.push('| Config | Pass | Rate | Tokens (total) | Avg latency | Tool calls |');
  lines.push('|---|---|---|---|---|---|');
  for (const config of configs) {
    const s = summarize(results, config);
    lines.push(
      `| ${s.config} | ${s.passed}/${s.total} | ${(s.passRate * 100).toFixed(0)}% | ${s.tokensTotal} | ${formatDuration(s.avgWallTimeMs)} | ${s.toolCallsTotal} |`,
    );
  }
  lines.push('');

  const baseline = summarize(results, 'prime-raw');
  for (const config of configs.filter((c) => c !== 'prime-raw')) {
    const s = summarize(results, config);
    const delta = (s.passRate - baseline.passRate) * 100;
    const tokenRatio = baseline.tokensTotal > 0 ? s.tokensTotal / baseline.tokensTotal : Number.NaN;
    lines.push(
      `- ${config} vs prime-raw: pass rate ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}pp, token ratio ${Number.isNaN(tokenRatio) ? '-' : tokenRatio.toFixed(2)}x`,
    );
  }

  // Per-config ContextOps token savings (estimated from captured payloads).
  for (const config of configs) {
    const scored = results.filter((r) => r.config === config && r.contextHealth && !r.contextHealth.skipped);
    if (scored.length === 0) continue;
    const saved = scored.reduce((a, r) => a + (r.contextHealth?.tokensSaved ?? 0), 0);
    lines.push(`- ${config} tokens saved (ContextOps, est.): ${saved}`);
  }
  lines.push('');

  // --- Matrix ----------------------------------------------------------------
  lines.push('## Per-task matrix');
  lines.push('');
  lines.push(`| Task | ${configs.join(' | ')} |`);
  lines.push(`|---|${configs.map(() => '---|').join('')}`);
  const taskIds = [...new Set(results.map((r) => r.taskId))];
  for (const taskId of taskIds) {
    const cells = configs.map((c) => cell(results.find((r) => r.config === c && r.taskId === taskId)));
    lines.push(`| ${taskId} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // --- Context health ---------------------------------------------------------
  const CI_RANK: Record<string, number> = { PASS: 0, WARN: 1, FAIL: 2, UNKNOWN: 3 };
  const healthRows = configs
    .map((config) => {
      const rows = results.filter((r) => r.config === config && r.contextHealth);
      if (rows.length === 0) return null;
      const scored = rows.filter((r) => r.contextHealth && !r.contextHealth.skipped);
      if (scored.length === 0) {
        return {
          config,
          captures: rows.reduce((a, r) => a + (r.contextHealth?.files ?? 0), 0),
          avg: null as number | null,
          ci: 'skipped',
          wasted: 0,
          saved: 0,
          tool: rows[0]?.contextHealth?.tool,
          note: rows[0]?.contextHealth?.reason,
        };
      }
      const avg = scored.reduce((a, r) => a + (r.contextHealth?.scoreAvg ?? 0), 0) / scored.length;
      const wasted = scored.reduce((a, r) => a + (r.contextHealth?.wastedTokens ?? 0), 0);
      const saved = scored.reduce((a, r) => a + (r.contextHealth?.tokensSaved ?? 0), 0);
      const ci = scored
        .map((r) => r.contextHealth?.ciStatus ?? 'UNKNOWN')
        .reduce((worst, c) => ((CI_RANK[c] ?? 3) > (CI_RANK[worst] ?? 3) ? c : worst), 'PASS');
      return { config, captures: scored.reduce((a, r) => a + (r.contextHealth?.files ?? 0), 0), avg, ci, wasted, saved, tool: rows[0]?.contextHealth?.tool };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (healthRows.length > 0) {
    lines.push('## Context health & token savings (ContextOps)');
    lines.push('');
    lines.push('| Config | Captures | CHS (avg) | Worst CI | Wasted tokens | Tokens saved (est.) |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of healthRows) {
      lines.push(
        `| ${row.config} | ${row.captures} | ${row.avg === null ? `skipped (${row.note ?? 'n/a'})` : row.avg.toFixed(1)} | ${row.ci} | ${row.wasted} | ${row.saved} |`,
      );
    }
    lines.push('');
    const tool = healthRows.find((r) => r.tool)?.tool ?? 'contextops';
    lines.push(
      `> Scored by [${tool}](https://pypi.org/project/contextops/) — the embedding-free structural linter for LLM context. Token savings are estimates from the captured payloads (total × estimated reduction).`,
    );
    lines.push('');
  }

  // --- Failures ----------------------------------------------------------------
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of failures) {
      lines.push(`- **${failure.config} / ${failure.taskId}**: ${(failure.error ?? 'unknown').slice(0, 300).replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeReport(
  results: TaskRunResult[],
  options: BenchOptions,
): { reportPath: string; jsonPath: string } {
  mkdirSync(options.outDir, { recursive: true });

  const reportPath = join(options.outDir, 'report.md');
  writeFileSync(reportPath, renderReport(results, options), 'utf8');

  const jsonPath = join(options.outDir, 'results.json');
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: options.model,
        configs: options.configs,
        maxAttempts: options.maxAttempts,
        retry: effectiveRetrySettings(options),
        results,
      },
      null,
      2,
    ),
    'utf8',
  );

  return { reportPath, jsonPath };
}
