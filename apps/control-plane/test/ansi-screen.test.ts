/** Unit tests for the ANSI to screen-grid renderer used by the headless harness. */

import { describe, expect, it } from 'vitest';
import { formatScreen, renderAnsiScreen } from '../src/ansi-screen.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function plain(s: string): string {
  return s.trimEnd();
}

describe('renderAnsiScreen', () => {
  it('writes plain text left to right and wraps at the column bound', () => {
    const s = renderAnsiScreen('ab', 2, 3);
    expect(s.lines[0]).toBe('ab ');
    expect(plain(s.lines[1])).toBe('');
  });

  it('honors cursor positioning (CSI H) and erases with K', () => {
    const out = 'xx' + ESC + '[2;1H' + 'yy' + ESC + '[2;3H' + ESC + '[K';
    const s = renderAnsiScreen(out, 3, 5);
    expect(s.lines[0]).toBe('xx   ');
    expect(s.lines[1]).toBe('yy   ');
  });

  it('strips SGR colors without corrupting the grid', () => {
    const red = ESC + '[31m';
    const s = renderAnsiScreen(red + 'hi' + ESC + '[0m', 1, 4);
    expect(s.lines[0]).toBe('hi  ');
  });

  it('clears the whole display with CSI 2J', () => {
    const s = renderAnsiScreen('abc' + ESC + '[2J' + 'd', 2, 4);
    expect(s.lines[0]).toBe('   d');
    expect(plain(s.lines[1])).toBe('');
  });

  it('skips OSC hyperlink payloads', () => {
    const link = ESC + ']8;;https://example.com' + BEL + 'click' + ESC + ']8;;' + BEL;
    const s = renderAnsiScreen(link, 1, 10);
    expect(s.lines[0]).toBe('click     ');
  });

  it('handles CR and LF', () => {
    const s = renderAnsiScreen('ab' + String.fromCharCode(13) + 'cd' + String.fromCharCode(10) + 'e', 2, 4);
    expect(s.lines[0]).toBe('cd  ');
    expect(s.lines[1]).toBe('  e ');
  });

  it('is safe against lone escape bytes', () => {
    const s = renderAnsiScreen('a' + ESC + 'b', 1, 3);
    expect(s.lines[0]).toBe('ab ');
  });
});

describe('formatScreen', () => {
  it('draws a bordered box', () => {
    const s = renderAnsiScreen('hi', 1, 2);
    const out = formatScreen(s, 'label');
    expect(out).toContain('--- label ---');
    expect(out).toContain('+--+');
    expect(out).toContain('|hi|');
  });
});
