/**
 * Sleep Cycle — report generation.
 *
 * Renders the sleep-cycle analysis as markdown: recurring failure clusters,
 * candidate fixes pulled from memory, and a per-session outcome/token table.
 */

import type { SessionSummary } from '@guppy/event-store';
import type { MemoryStore } from '@guppy/memory';
import type { FailureCluster } from './cluster.js';

export interface SleepCycleReport {
  generatedAt: number;
  sessionCount: number;
  clusters: FailureCluster[];
  /** Cluster signature -> candidate fix summaries from the memory store. */
  candidateFixes: Record<string, string[]>;
  sessions: SessionSummary[];
}

export function renderReport(report: SleepCycleReport): string {
  const lines: string[] = [];
  const at = new Date(report.generatedAt).toISOString();

  lines.push('# Guppy Sleep Cycle Report');
  lines.push('');
  lines.push(`Generated: ${at}`);
  lines.push(`Sessions analyzed: ${report.sessionCount}`);
  lines.push(`Failure clusters: ${report.clusters.length}`);
  lines.push('');

  lines.push('## Recurring failures');
  lines.push('');
  if (report.clusters.length === 0) {
    lines.push('_No test or typecheck failures recorded._');
  } else {
    lines.push('| # | Kind | Failure | Occurrences | Sessions | Resolved? | Top candidate files |');
    lines.push('|---|------|---------|-------------|----------|-----------|---------------------|');
    report.clusters.forEach((cluster, i) => {
      const files = Object.entries(cluster.filesChanged)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([file, count]) => `${file} (${count})`)
        .join(', ');
      lines.push(
        `| ${i + 1} | ${cluster.kind} | ${escapeCell(cluster.name)} | ${cluster.occurrences} | ` +
          `${cluster.sessionIds.length} | ${cluster.everResolved ? 'yes' : 'no'} | ${files || '-'} |`,
      );
    });
  }
  lines.push('');

  const fixes = report.clusters.filter((c) => (report.candidateFixes[c.signature] ?? []).length > 0);
  lines.push('## Candidate fixes from memory');
  lines.push('');
  if (fixes.length === 0) {
    lines.push('_No matching fix memories yet — they accumulate as successful runs are ingested._');
  } else {
    for (const cluster of fixes) {
      lines.push(`### ${cluster.kind}: ${cluster.name}`);
      for (const summary of report.candidateFixes[cluster.signature] ?? []) {
        lines.push(`- ${summary}`);
      }
      lines.push('');
    }
  }
  lines.push('');

  lines.push('## Session outcomes');
  lines.push('');
  if (report.sessions.length === 0) {
    lines.push('_No session summaries in the index._');
  } else {
    lines.push('| Task | Session | Outcome | Events | Tokens | Tool calls | Duration |');
    lines.push('|------|---------|---------|--------|--------|------------|----------|');
    for (const s of report.sessions) {
      const duration = s.endedAt ? `${Math.round((s.endedAt - s.startedAt) / 1000)}s` : 'running';
      lines.push(
        `| ${s.taskId} | ${s.sessionId.slice(0, 8)}… | ${s.outcome ?? '-'} | ${s.eventCount} | ` +
          `${s.tokensTotal} | ${s.toolCalls} | ${duration} |`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** Match memory fix summaries to clusters by tokenized failure-name overlap. */
export function matchCandidateFixes(
  clusters: FailureCluster[],
  memory: MemoryStore,
): Record<string, string[]> {
  const fixes: Record<string, string[]> = {};
  for (const cluster of clusters) {
    const scored = memory.retrieveForFailure(cluster.name, 3);
    if (scored.length > 0) {
      fixes[cluster.signature] = scored.map((s) => s.memory.summary);
    }
  }
  return fixes;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').slice(0, 80);
}
