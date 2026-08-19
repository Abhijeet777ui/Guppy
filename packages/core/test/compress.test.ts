/**
 * Unit tests for conversation-history compression — the pure function, no
 * model involved. The e2e (core-runtime.e2e.test.ts) proves it is wired into
 * the turn loop and that the model actually receives the recap.
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/openai-client.js';
import {
  COMPRESSED_HISTORY_HEADER,
  RECAP_LATEST_RESULT_CHARS,
  compressMessages,
  estimateMessageTokens,
} from '../src/index.js';

const systemMsg: ChatMessage = { role: 'system', content: 'You are Guppy.' };
const taskMsg: ChatMessage = { role: 'user', content: 'Fix the bug in src/math.ts' };

function assistant(name: string, args: unknown, id = 'call-1'): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  };
}

function toolResult(content: string, name = 'read_file'): ChatMessage {
  return { role: 'tool', tool_call_id: 'call-1', name, content };
}

function textAnswer(content: string): ChatMessage {
  return { role: 'assistant', content };
}

const BIG = 'x'.repeat(20_000); // ~5k tokens at the chars/4 heuristic

describe('estimateMessageTokens', () => {
  it('counts content, tool names, and tool-call JSON at ~4 chars/token', () => {
    const messages: ChatMessage[] = [
      systemMsg,
      taskMsg,
      assistant('read_file', { path: 'a.ts' }),
      toolResult('ok', 'read_file'),
    ];
    const tokens = estimateMessageTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    // A 20k-char tool result is ~5k tokens.
    expect(estimateMessageTokens([toolResult(BIG)])).toBeGreaterThan(4_000);
  });

  it('is 0 for messages with no text at all', () => {
    expect(estimateMessageTokens([{ role: 'assistant', content: null }])).toBe(0);
  });
});

describe('compressMessages', () => {
  it('is a no-op under the budget (same reference, zero turns)', () => {
    const messages: ChatMessage[] = [systemMsg, taskMsg, textAnswer('short')];
    const result = compressMessages(messages, { maxHistoryTokens: 10_000, keepRecentTurns: 6 });
    expect(result.compressedTurns).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it('budget 0 disables compression entirely', () => {
    const messages: ChatMessage[] = [
      systemMsg,
      taskMsg,
      assistant('read_file', { path: 'a.ts' }),
      toolResult(BIG),
    ];
    const result = compressMessages(messages, { maxHistoryTokens: 0, keepRecentTurns: 6 });
    expect(result.compressedTurns).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it('compresses older turns, keeps the system prompt and recent turns verbatim', () => {
    const messages: ChatMessage[] = [
      systemMsg,
      taskMsg,
      assistant('read_file', { path: 'a.ts' }),
      toolResult(BIG), // turn 1
      assistant('read_file', { path: 'b.ts' }),
      toolResult(BIG), // turn 2
      assistant('read_file', { path: 'c.ts' }),
      toolResult(BIG), // turn 3
    ];
    const result = compressMessages(messages, { maxHistoryTokens: 2_000, keepRecentTurns: 1 });

    expect(result.compressedTurns).toBeGreaterThan(0);
    expect(result.messages[0]).toBe(systemMsg);
    // The recap is a system message mentioning the compressed tool names.
    const recap = result.messages[1]!;
    expect(recap.role).toBe('system');
    expect(recap.content).toContain(COMPRESSED_HISTORY_HEADER);
    expect(recap.content).toContain('read_file');
    // The most recent turn survived verbatim.
    expect(result.messages[result.messages.length - 2]).toEqual(messages[messages.length - 2]);
    expect(result.messages[result.messages.length - 1]).toEqual(messages[messages.length - 1]);
    // Compression actually shrank the estimate.
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it('preserves the task line and plain text answers in the recap', () => {
    const messages: ChatMessage[] = [
      systemMsg,
      taskMsg,
      textAnswer('First attempt: inspected the file, no fix yet.'), // old turn
      assistant('write_file', { path: 'src/math.ts', content: 'ok' }),
      toolResult(BIG, 'write_file'), // big enough to blow the budget
      textAnswer('Done.'), // most recent turn
    ];
    const result = compressMessages(messages, { maxHistoryTokens: 2_000, keepRecentTurns: 1 });
    // Two old turns compressed ('First attempt' + the write_file turn); only 'Done.' stays verbatim.
    expect(result.compressedTurns).toBe(2);
    const recap = result.messages[1]!.content ?? '';
    expect(recap).toContain('Fix the bug in src/math.ts'); // TASK line survives
    expect(recap).toContain('First attempt: inspected the file'); // text answer survives
    expect(result.messages[result.messages.length - 1]).toEqual(textAnswer('Done.'));
  });

  it('never splits an assistant from its tool results at the boundary', () => {
    // Two tool calls per turn so the boundary can't land mid-group; big
    // results so the history is over budget and compression must fire.
    const twoResults = (name: string): ChatMessage[] => [toolResult(`${name}-1 ${BIG}`, name), toolResult(`${name}-2`, name)];
    const messages: ChatMessage[] = [
      systemMsg,
      taskMsg,
      assistant('read_file', { path: 'a.ts' }),
      ...twoResults('a'),
      assistant('read_file', { path: 'b.ts' }),
      ...twoResults('b'),
      assistant('read_file', { path: 'c.ts' }),
      ...twoResults('c'),
    ];
    const result = compressMessages(messages, { maxHistoryTokens: 2_000, keepRecentTurns: 1 });
    // The kept suffix starts with an assistant and its full tool group follows.
    const suffix = result.messages.slice(1);
    const firstAssistant = suffix.findIndex((m) => m.role === 'assistant');
    expect(firstAssistant).toBeGreaterThanOrEqual(0);
    // Everything after the first kept assistant is its tool results or later turns — no orphan tools.
    const roles = suffix.map((m) => m.role);
    const firstTool = roles.findIndex((r) => r === 'tool');
    if (firstTool >= 0) {
      expect(roles[firstTool - 1]).toBe('assistant');
    }
    expect(result.compressedTurns).toBeGreaterThan(0);
  });

  it('keeps the most recent compressed tool result verbatim (fixes re-reads)', () => {
    const messages: ChatMessage[] = [
      systemMsg,
      taskMsg,
      assistant('read_file', { path: 'a.ts' }),
      toolResult('small-result-a', 'read_file'), // older tool result → truncated
      assistant('read_file', { path: 'b.ts' }),
      toolResult(BIG, 'read_file'), // most recent compressed tool result → verbatim
      assistant('read_file', { path: 'c.ts' }),
      toolResult(BIG, 'read_file'), // kept with the most recent turn
    ];
    const result = compressMessages(messages, { maxHistoryTokens: 2_000, keepRecentTurns: 1 });
    const recap = result.messages[1]!.content ?? '';
    expect(recap).toContain('[most recent result, verbatim:]');
    // The earlier tool result is collapsed to a first-line truncation.
    expect(recap).toContain('small-result-a');
    // The most recent *compressed* tool result survives capped (enough to act
    // on the file without re-reading, but not the full 20k chars).
    expect(recap).toContain(BIG.slice(0, RECAP_LATEST_RESULT_CHARS));
    // The cap actually applies: the full 20k body is NOT all there.
    expect(recap).not.toContain(BIG);
  });
});
