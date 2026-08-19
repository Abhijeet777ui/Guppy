/**
 * A minimal ANSI escape-sequence to screen-grid renderer.
 *
 * The headless TUI harness captures the raw bytes the TUI writes to the
 * terminal (cursor positions, SGR colors, erase sequences, text). This module
 * replays those bytes into a row/col character grid so a test can dump the
 * *actual rendered screen* without a real terminal. It is deliberately small:
 * it understands the sequences pi-tui's differential renderer emits and
 * ignores everything else.
 *
 * Sequences handled:
 *   CSI H/f  cursor position (1-based; no params = home)
 *   CSI A/B/C/D  cursor up/down/right/left
 *   CSI K  erase in line (0 = to end, 1 = to start, 2 = whole line)
 *   CSI J  erase in display (2 = whole screen, 0 = to end, 1 = to start)
 *   CSI m  SGR - ignored for rendering (colors are stripped)
 *   CSI ?...h/l  private modes - ignored
 *   OSC ]...BEL/ST  (hyperlinks, OSC 11) - ignored
 *   DCS _...BEL  (pi-tui's zero-width cursor marker) - ignored
 *   CR/LF  carriage return / line feed
 *   plain text  written at the cursor
 *
 * Everything else is skipped defensively; an unknown sequence must never
 * corrupt the grid. Control characters are built from char codes so the
 * module contains no backslash escape literals at all.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const BS = String.fromCharCode(92); // backslash
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

/** A rendered screen: `rows` strings of `cols` characters each. */
export interface RenderedScreen {
  rows: number;
  cols: number;
  /** The grid, one string per row. */
  lines: string[];
}

/** Replay terminal output into a screen grid and return the final frame. */
export function renderAnsiScreen(output: string, rows: number, cols: number): RenderedScreen {
  const grid: string[][] = [];
  for (let r = 0; r < rows; r++) grid.push(new Array<string>(cols).fill(' '));

  let row = 0;
  let col = 0;

  const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

  const put = (ch: string): void => {
    if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row]![col] = ch;
    col = clamp(col + 1, 0, cols);
  };

  const eraseLine = (mode: number): void => {
    if (row < 0 || row >= rows) return;
    const line = grid[row]!;
    if (mode === 2 || mode === 0) {
      for (let c = col; c < cols; c++) line[c] = ' ';
      if (mode === 2) for (let c = 0; c < col; c++) line[c] = ' ';
    } else if (mode === 1) {
      for (let c = 0; c <= col; c++) line[c] = ' ';
    }
  };

  const eraseDisplay = (mode: number): void => {
    if (mode === 2) {
      for (let r = 0; r < rows; r++) grid[r]!.fill(' ');
    } else if (mode === 0) {
      eraseLine(0);
      for (let r = row + 1; r < rows; r++) grid[r]!.fill(' ');
    } else if (mode === 1) {
      eraseLine(1);
      for (let r = 0; r < row; r++) grid[r]!.fill(' ');
    }
  };

  let i = 0;
  while (i < output.length) {
    const ch = output[i]!;
    if (ch === ESC) {
      const next = output[i + 1];
      if (next === '[') {
        // CSI: collect params until the final byte (@-~).
        let j = i + 2;
        let params = '';
        while (j < output.length && !/[@-~]/.test(output[j]!)) {
          params += output[j]!;
          j++;
        }
        const finalByte = output[j] ?? '';
        i = j + 1;
        const nums = params.split(';').map((p) => (p === '' ? 0 : Number(p)));
        const a = nums[0] ?? 0;
        const b = nums[1] ?? 0;
        switch (finalByte) {
          case 'H':
          case 'f': {
            // Default (no params) means home; a bare '0' behaves as 1.
            row = clamp((a || 1) - 1, 0, rows - 1);
            col = clamp((b || 1) - 1, 0, cols - 1);
            break;
          }
          case 'A':
            row = clamp(row - (a || 1), 0, rows - 1);
            break;
          case 'B':
            row = clamp(row + (a || 1), 0, rows - 1);
            break;
          case 'C':
            col = clamp(col + (a || 1), 0, cols - 1);
            break;
          case 'D':
            col = clamp(col - (a || 1), 0, cols - 1);
            break;
          case 'K':
            eraseLine(a);
            break;
          case 'J':
            eraseDisplay(a);
            break;
          default:
            // SGR (m), private modes (?...h/l), and anything else: no-op.
            break;
        }
        continue;
      }
      if (next === ']') {
        // OSC: skip to BEL or ST (ESC followed by backslash).
        let j = i + 2;
        while (j < output.length && output[j] !== BEL && !(output[j] === ESC && output[j + 1] === BS)) j++;
        i = output[j] === ESC ? j + 2 : j + 1;
        continue;
      }
      if (next === '_') {
        // DCS (pi-tui's zero-width cursor marker): skip to BEL.
        let j = i + 2;
        while (j < output.length && output[j] !== BEL) j++;
        i = j + 1;
        continue;
      }
      // Lone ESC: skip it. A charset selector also eats its one-char argument.
      i = next === '(' || next === ')' ? i + 2 : i + 1;
      continue;
    }
    if (ch === CR) {
      col = 0;
      i++;
      continue;
    }
    if (ch === LF) {
      row = clamp(row + 1, 0, rows - 1);
      i++;
      continue;
    }
    put(ch);
    i++;
  }

  return {
    rows,
    cols,
    lines: grid.map((r) => r!.join('')),
  };
}

/** Format a rendered screen for printing, with a border and row numbers. */
export function formatScreen(screen: RenderedScreen, label?: string): string {
  const out: string[] = [];
  if (label) out.push('--- ' + label + ' ---');
  const ruler = '+' + '-'.repeat(screen.cols) + '+';
  out.push(ruler);
  for (let r = 0; r < screen.rows; r++) {
    const line = screen.lines[r];
    out.push('|' + line + '|');
  }
  out.push(ruler);
  return out.join(String.fromCharCode(10));
}
