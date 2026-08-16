/**
 * Minimal unified-diff parsing + application for the `apply_patch` tool.
 *
 * Supports the common `--- a/path` / `+++ b/path` header form (plus plain
 * paths and `/dev/null` for creates/deletes), `@@ -l,c +l,c @@` hunk headers,
 * and context/add/remove lines. Context matching is fuzzy: if the hunk's
 * declared line number has drifted from the file, the applier slides a window
 * around the expected position to find the best context match.
 *
 * Pure and dependency-free — the workspace manager owns path containment and
 * the actual file I/O around these helpers.
 */

export interface HunkLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

export interface Hunk {
  /** 1-based first line of the old block (0 when creating a file). */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface ParsedPatchFile {
  path: string;
  isNew: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** Strip the `a/` / `b/` prefix git emits on header paths. */
function stripPrefix(path: string): string {
  const match = path.match(/^[ab]\/(.+)$/);
  return match ? match[1]! : path;
}

/** Parse a multi-file unified diff into per-file hunks (order preserved). */
export function parseUnifiedDiff(patch: string): ParsedPatchFile[] {
  const files: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | null = null;
  let hunk: Hunk | null = null;

  for (const raw of patch.split(/\r?\n/)) {
    if (
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('new file mode') ||
      raw.startsWith('deleted file mode')
    ) {
      continue;
    }

    if (raw.startsWith('--- ')) {
      // Start a new file, finalizing the previous one.
      if (current && current.path !== '') files.push(current);
      const from = raw.slice(4).trim();
      current = { path: '', isNew: from === '/dev/null', isDelete: false, hunks: [] };
      if (!current.isNew) current.path = stripPrefix(from);
      hunk = null;
      continue;
    }

    if (raw.startsWith('+++ ')) {
      if (!current) continue;
      const to = raw.slice(4).trim();
      current.isDelete = to === '/dev/null';
      if (!current.isDelete) current.path = stripPrefix(to);
      hunk = null;
      continue;
    }

    if (raw.startsWith('@@')) {
      if (!current) continue;
      const match = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      hunk = {
        oldStart: parseInt(match[1]!, 10),
        oldLines: match[2] !== undefined ? parseInt(match[2], 10) : 1,
        newStart: parseInt(match[3]!, 10),
        newLines: match[4] !== undefined ? parseInt(match[4], 10) : 1,
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    // A bare empty string is the split artifact of the patch's trailing
    // newline; a single space is a real empty context line, so keep that.
    if (raw === '') continue;

    // `\ No newline at end of file` marker — not a content line.
    if (raw.startsWith('\\')) continue;

    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'remove', text: raw.slice(1) });
    } else {
      hunk.lines.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw });
    }
  }

  if (current && current.path !== '') files.push(current);

  return files.filter((f) => f.path !== '' && (f.isNew || f.isDelete || f.hunks.length > 0));
}

/** Number of lines a hunk consumes from the old file (context + removed). */
function oldBlockLength(hunk: Hunk): number {
  return hunk.lines.reduce((n, l) => n + (l.kind === 'add' ? 0 : 1), 0);
}

/** Number of context+removed lines that match the candidate position. */
function scoreAt(lines: string[], needle: string[], offset: number): number {
  let score = 0;
  for (let i = 0; i < needle.length; i++) {
    if (lines[offset + i] === needle[i]) score++;
  }
  return score;
}

/**
 * Find the line index (0-based) where a hunk's old block should be spliced.
 * Prefers the declared `oldStart`, then slides ±window lines to tolerate the
 * file having drifted. Returns null when no context line matches at all.
 */
function findAnchor(lines: string[], hunk: Hunk, window = 200): number | null {
  const needle = hunk.lines.filter((l) => l.kind !== 'add').map((l) => l.text);
  if (needle.length === 0) {
    // Pure insertion (e.g. a new file): anchor at the declared position.
    return Math.max(0, Math.min(hunk.oldStart - 1, lines.length));
  }

  const exact = hunk.oldStart - 1;
  if (exact >= 0 && exact + needle.length <= lines.length && scoreAt(lines, needle, exact) === needle.length) {
    return exact;
  }

  let best = -1;
  let bestScore = 0;
  const lo = Math.max(0, exact - window);
  const hi = Math.min(lines.length - needle.length, exact + window);
  for (let off = lo; off <= hi; off++) {
    const score = scoreAt(lines, needle, off);
    if (score > bestScore) {
      bestScore = score;
      best = off;
      if (score === needle.length) break;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Apply parsed hunks to a file's current content, returning the new content.
 * Hunks are applied from last to first so earlier hunks' line numbers remain
 * valid as the file mutates. Throws when a hunk's context cannot be found.
 */
export function applyHunks(original: string, hunks: Hunk[]): string {
  const crlf = original.includes('\r\n');
  const trailing = original.endsWith('\n') ? (crlf ? '\r\n' : '\n') : '';
  const rawLines = original === '' ? [] : original.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  // Normalize CRLF → LF for matching; restore the original style on output.
  const lines = rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  // Apply from the bottom of the file up so earlier positions stay stable.
  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const hunk of ordered) {
    const anchor = findAnchor(lines, hunk);
    if (anchor === null) {
      throw new Error(`patch hunk failed to match context (around line ${hunk.oldStart})`);
    }
    const replacement = hunk.lines.filter((l) => l.kind !== 'remove').map((l) => l.text);
    lines.splice(anchor, oldBlockLength(hunk), ...replacement);
  }

  return lines.join(crlf ? '\r\n' : '\n') + trailing;
}
