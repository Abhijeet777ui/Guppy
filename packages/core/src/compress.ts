/**
 * Conversation-history compression — keep long runs inside the context window.
 *
 * The turn loop appends an assistant message + one tool message per call
 * (each tool result up to 20k chars), so a long task grows the history
 * unboundedly and eventually blows the model's window. `compressMessages`
 * replaces the *older* turns with one compact `system` recap while the most
 * recent turns stay verbatim — deterministic, no LLM call (the repo's
 * "deterministic-first" ethos; LLM summarization can layer on later).
 */

import type { ChatMessage } from './openai-client.js';

export interface CompressionOptions {
  /**
   * Budget in estimated tokens for the history (everything except the system
   * prompt). Compress when over budget; 0 disables.
   */
  maxHistoryTokens: number;
  /** How many of the most recent model turns stay verbatim. */
  keepRecentTurns: number;
}

export interface CompressionResult {
  messages: ChatMessage[];
  /** The older turns replaced by the recap (empty = nothing compressed). */
  older: ChatMessage[];
  /** Model turns replaced by the recap (0 = nothing compressed). */
  compressedTurns: number;
  /** Estimated history tokens before/after (chars/4 heuristic). */
  tokensBefore: number;
  tokensAfter: number;
}

/** The recap's header; the live-stream + tests key off it. */
export const COMPRESSED_HISTORY_HEADER = '=== COMPRESSED HISTORY ===';

/**
 * How much of the most recent compressed tool result survives verbatim in the
 * recap. Big enough to keep the file the agent was just looking at (the
 * relevant code is usually near the top), small enough that the recap still
 * compresses — keeping a full 20k-char result verbatim made the recap nearly
 * as large as what it replaced (STATUS bug #17 follow-up).
 */
export const RECAP_LATEST_RESULT_CHARS = 4_000;

/**
 * Cheap token estimate over a message list: chars/4 over content + tool-call
 * JSON. Same order of magnitude as the repo's tiktoken fallback; tiktoken
 * stays out of @guppy/core.
 */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (message.content) chars += message.content.length;
    if (message.name) chars += message.name.length + 2;
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        chars += call.function.name.length + call.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Count assistant-led model turns in a message slice. */
function countAssistantTurns(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Render the older turns as one system recap: what the assistant ran and
 * what each tool returned (truncated), preserving order. The *most recent*
 * tool result is kept verbatim (the loop already caps it at 20k chars) so the
 * model retains the file it just read — truncating it to a one-liner is what
 * caused the model to re-read after a recap (STATUS bug #17).
 */
function buildRecap(older: ChatMessage[]): ChatMessage {
  const lines: string[] = [COMPRESSED_HISTORY_HEADER, '', 'Older turns, compressed to fit the context window:'];
  // Index of the last tool message: its content stays verbatim.
  let lastToolIndex = -1;
  for (let idx = 0; idx < older.length; idx++) {
    if (older[idx]!.role === 'tool') lastToolIndex = idx;
  }
  for (let idx = 0; idx < older.length; idx++) {
    const message = older[idx]!;
    if (message.role === 'user') {
      if (message.content) lines.push(`- TASK: ${truncate(message.content, 200)}`);
    } else if (message.role === 'assistant') {
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const call of message.tool_calls) {
          lines.push(`- ran ${call.function.name}(${truncate(call.function.arguments, 120)})`);
        }
      } else if (message.content) {
        lines.push(`- answered: ${truncate(message.content, 200)}`);
      }
    } else if (message.role === 'tool') {
      if (idx === lastToolIndex) {
        // Keep the most recent tool result (capped) so the agent can act on
        // the file it just read instead of re-reading it after the recap.
        lines.push(`  → [most recent result, verbatim:]\n${truncate(message.content ?? '', RECAP_LATEST_RESULT_CHARS)}`);
      } else {
        const result = (message.content ?? message.name ?? '').split('\n')[0] ?? '';
        lines.push(`  → ${truncate(result, 300)}`);
      }
    }
  }
  return { role: 'system', content: lines.join('\n') };
}

/**
 * Compress the older turns of a message list once the history exceeds the
 * budget. The system prompt (index 0) is never touched; the most recent
 * `keepRecentTurns` model turns stay verbatim; everything older becomes one
 * recap message. Returns the new list (a no-op when under budget or disabled).
 */
export function compressMessages(messages: ChatMessage[], options: CompressionOptions): CompressionResult {
  const tokensBefore = estimateMessageTokens(messages);
  if (options.maxHistoryTokens <= 0 || messages.length < 2) {
    return { messages, older: [], compressedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const history = messages.slice(1);
  if (estimateMessageTokens(history) <= options.maxHistoryTokens) {
    return { messages, older: [], compressedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  // Walk from the end, keeping the last `keepRecentTurns` assistant turns
  // verbatim. The boundary lands on a full turn automatically: the walk stops
  // immediately after counting an assistant, and every message newer than it
  // (its own tool results, plus any later turns) is already in the kept
  // suffix — so an assistant is never separated from its tool results.
  const kept: ChatMessage[] = [];
  let keptTurns = 0;
  let i = history.length - 1;
  while (i >= 0 && keptTurns < options.keepRecentTurns) {
    const message = history[i]!;
    kept.unshift(message);
    if (message.role === 'assistant') keptTurns++;
    i--;
  }

  const older = history.slice(0, i + 1);
  if (older.length === 0) {
    return { messages, older: [], compressedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const result: ChatMessage[] = [messages[0]!, buildRecap(older), ...kept];
  return {
    messages: result,
    older,
    compressedTurns: countAssistantTurns(older),
    tokensBefore,
    tokensAfter: estimateMessageTokens(result),
  };
}
