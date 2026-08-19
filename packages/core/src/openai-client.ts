/**
 * OpenAI-compatible chat completions client.
 *
 * Talks to any OpenAI-compatible `/chat/completions` endpoint over fetch —
 * no pi, no prime, no SDK. Used by Guppy's native agent loop so the harness
 * owns the entire model boundary.
 */

import type { ModelConfig } from './model.js';
import { resolveApiKey, resolveBaseUrl } from './model.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Tool name this result belongs to (role === 'tool'). */
  name?: string;
  /** Id of the tool call this result answers (role === 'tool'). */
  tool_call_id?: string;
  /** Tool calls the assistant requested (role === 'assistant'). */
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface OpenAIToolCallResponse {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Thrown when the caller's AbortSignal fires mid-request (user pressed Ctrl+C
 * in chat). Distinct from a timeout or a network failure: the runtime maps it
 * to outcome 'cancelled' instead of 'failure', and it is never retried.
 */
export class CancelledError extends Error {
  constructor() {
    super('Model request cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Sliding-window rate limiter, shared across every client instance in the
 * process. The bench constructs a fresh `OpenAIChatClient` per task, so a
 * per-instance limiter would reset its state on every task and never throttle;
 * keying by `provider | baseUrl` makes the limit hold across the whole run.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  /**
   * Block until a request slot is available under a fixed 60-second window of
   * at most `rpm` requests. Returns immediately when `rpm` is unset/zero.
   */
  async acquire(key: string, rpm: number | undefined): Promise<void> {
    if (!rpm || rpm <= 0) return;

    let window = this.buckets.get(key);
    if (!window) {
      window = [];
      this.buckets.set(key, window);
    }

    for (;;) {
      const nowMs = Date.now();
      const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
      while (window.length > 0 && (window[0] ?? 0) <= cutoff) window.shift();
      if (window.length < rpm) {
        window.push(nowMs);
        return;
      }
      // The oldest request leaves the window at `oldest + WINDOW`; wait for it
      // to expire (plus a hair of margin) before re-checking.
      const oldest = window[0] ?? nowMs;
      await sleep(Math.max(0, oldest + RATE_LIMIT_WINDOW_MS - nowMs + 1));
    }
  }
}

/** Process-wide limiter so pacing survives the bench's per-task clients. */
const sharedRateLimiter = new RateLimiter();

export class OpenAIChatClient {
  private readonly config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = config;
  }

  /**
   * One non-streaming completion. Returns the assistant message's text and/or
   * tool calls plus token usage.
   */
  async complete(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const url = `${resolveBaseUrl(this.config)}/chat/completions`;
    const apiKey = resolveApiKey(this.config);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.config.headers,
    };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    const body: Record<string, unknown> = {
      ...this.config.extraBody,
      model: this.config.model,
      messages: normalizeMessages(messages),
    };
    if (tools && tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }
    if (this.config.maxTokens !== undefined) body['max_tokens'] = this.config.maxTokens;
    if (this.config.temperature !== undefined) body['temperature'] = this.config.temperature;

    const response = await this.requestWithRetry(url, headers, body, signal);

    const json = (await withIdleTimeout(response.json(), this.config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS, signal)) as {
      model?: string;
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: OpenAIToolCallResponse[];
        };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
    };

    const choice = json.choices?.[0];
    if (!choice) {
      throw new Error('Model returned no choices in its completion response');
    }

    const message = choice.message ?? {};
    const content = message.content ?? null;
    const toolCalls = (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }));

    return finalizeCompletion(
      content,
      toolCalls,
      choice.finish_reason ?? 'stop',
      json.model ?? this.config.model,
      {
        inputTokens: json.usage?.prompt_tokens ?? json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? json.usage?.output_tokens ?? 0,
      },
    );
  }

  /**
   * Streaming completion over SSE. Invokes `onDelta` with the accumulated
   * assistant text as it arrives, and returns the same `CompletionResult`
   * shape as `complete` (tool-call argument fragments are stitched together
   * across deltas, and the fenced-JSON fallback still applies to the final
   * accumulated content).
   */
  async completeStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    onDelta?: (accumulatedText: string) => void,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const url = `${resolveBaseUrl(this.config)}/chat/completions`;
    const apiKey = resolveApiKey(this.config);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.config.headers,
    };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    const body: Record<string, unknown> = {
      ...this.config.extraBody,
      model: this.config.model,
      messages: normalizeMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }
    if (this.config.maxTokens !== undefined) body['max_tokens'] = this.config.maxTokens;
    if (this.config.temperature !== undefined) body['temperature'] = this.config.temperature;

    const response = await this.requestWithRetry(url, headers, body, signal);
    if (!response.body) {
      throw new Error('Model returned an empty stream body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = 'stop';
    let model = this.config.model;
    let usage = { inputTokens: 0, outputTokens: 0 };
    const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
    const idleMs = this.config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

    try {
      for (;;) {
        // A caller abort (Ctrl+C) mid-stream must stop the loop, not just the
        // next fetch: the reader may otherwise idle waiting for deltas.
        if (signal?.aborted) throw new CancelledError();
        const { done, value } = await readWithIdleTimeout(reader, idleMs, signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '' || data === '[DONE]') continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (typeof chunk['model'] === 'string') model = chunk['model'] as string;
          const rawUsage = chunk['usage'] as
            | { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
            | undefined;
          if (rawUsage) {
            usage = {
              inputTokens: rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0,
              outputTokens: rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0,
            };
          }

          const choice = (chunk['choices'] as Array<Record<string, unknown>> | undefined)?.[0];
          if (!choice) continue;
          const delta = choice['delta'] as Record<string, unknown> | undefined;
          if (!delta) continue;

          const text = delta['content'];
          if (typeof text === 'string' && text !== '') {
            content += text;
            onDelta?.(content);
          }

          const rawCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
          if (rawCalls) {
            for (const raw of rawCalls) {
              const index = typeof raw['index'] === 'number' ? (raw['index'] as number) : 0;
              const acc = toolCallsByIndex.get(index) ?? { id: '', name: '', args: '' };
              if (typeof raw['id'] === 'string') acc.id = raw['id'] as string;
              const fn = raw['function'] as Record<string, unknown> | undefined;
              if (fn) {
                if (typeof fn['name'] === 'string') acc.name += fn['name'] as string;
                if (typeof fn['arguments'] === 'string') acc.args += fn['arguments'] as string;
              }
              toolCallsByIndex.set(index, acc);
            }
          }

          const reason = choice['finish_reason'];
          if (typeof reason === 'string' && reason !== '') finishReason = reason;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({
        id: acc.id || `stream-${Math.random().toString(36).slice(2, 10)}`,
        function: { name: acc.name, arguments: acc.args },
      }))
      .filter((call) => call.function.name !== '');

    return finalizeCompletion(content || null, toolCalls, finishReason, model, usage);
  }

  /**
   * POST the completion payload, retrying transient failures (429, 5xx, and
   * network errors) with exponential backoff + full jitter. Honors the
   * server's `Retry-After` header when present; other 4xx errors fail fast.
   */
  private async requestWithRetry(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = this.config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const maxDelayMs = this.config.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rateLimitKey = `${this.config.provider}|${resolveBaseUrl(this.config)}`;

    for (let attempt = 0; ; attempt++) {
      // A caller abort (Ctrl+C) is final: stop pacing/retrying and surface it.
      if (signal?.aborted) throw new CancelledError();

      // Every HTTP request — including retries — counts against the provider's
      // rate limit, so pace before each fetch rather than once per call.
      await sharedRateLimiter.acquire(rateLimitKey, this.config.requestsPerMinute);

      let response: Response;
      // Bound every attempt so a hung endpoint (accepts the connection but
      // never sends headers) can't stall an unattended run forever. A timeout
      // is a transient failure and retries like a network error. An external
      // abort is forwarded into the same controller so the in-flight fetch
      // tears down immediately.
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        if (signal?.aborted) throw new CancelledError();
        const timedOut =
          typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
        const message = timedOut
          ? `Model request timed out after ${timeoutMs}ms (${url})`
          : `Model request failed (${url}): ${e instanceof Error ? e.message : String(e)}`;
        if (attempt < maxRetries) {
          await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
          continue;
        }
        throw new Error(message);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      if (response.ok) return response;

      const status = response.status;
      const retryable = status === 429 || status >= 500;
      if (retryable && attempt < maxRetries) {
        try {
          await response.body?.cancel();
        } catch {
          // Body cancellation is best-effort; the retry is what matters.
        }
        await sleep(retryDelayMs(response.headers.get('retry-after'), attempt, baseDelayMs, maxDelayMs));
        continue;
      }

      const text = await response.text().catch(() => '');
      throw new Error(
        `Model returned HTTP ${status} (${url}): ${text.slice(0, 500) || response.statusText}`,
      );
    }
  }
}

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Race a promise against an idle deadline (used for the non-streaming body
 * read). A caller abort wins immediately as CancelledError; the deadline wins
 * as a stall error so a silent endpoint can't hang the turn.
 */
async function withIdleTimeout<T>(
  promise: Promise<T>,
  idleMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw new CancelledError();
  let timer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    void promise.catch(() => {}); // The read can't be cancelled; swallow its late rejection.
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await new Promise<T>((resolve, reject) => {
      const fail = (e: unknown): void => reject(e instanceof Error ? e : new Error(String(e)));
      timer = setTimeout(
        () => reject(new Error(`Model response stalled — no data for ${Math.round(idleMs / 1000)}s`)),
        idleMs,
      );
      signal?.addEventListener('abort', () => reject(new CancelledError()), { once: true });
      promise.then(resolve, fail);
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Read one stream chunk, giving up after `idleMs` of silence. The request
 * timeout only covers time-to-first-byte (it is cleared once headers arrive),
 * so without this a server that accepts the connection and then stalls can
 * hang the turn forever. A caller abort cancels the stuck read.
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw new CancelledError();
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    cancelled = true;
    // Cancelling the reader rejects the pending read below.
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      timer = setTimeout(() => {
        cancelled = true;
        void reader.cancel().catch(() => {});
        reject(new Error(`Model stream stalled — no data for ${Math.round(idleMs / 1000)}s`));
      }, idleMs);
      reader.read().then(
        (r) => resolve(r),
        (e) => reject(cancelled ? new CancelledError() : e),
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Exponential backoff with full jitter: a random delay in [0, min(cap, base * 2^attempt)]. */
function backoffDelayMs(attempt: number, base: number, cap: number): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.random() * ceiling;
}

/** Pick the retry delay, preferring the server's `Retry-After` when present. */
function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  base: number,
  cap: number,
): number {
  const fromHeader = parseRetryAfterMs(retryAfter);
  if (fromHeader !== null) return Math.min(fromHeader, cap);
  return backoffDelayMs(attempt, base, cap);
}

/** Parse a `Retry-After` value (delta-seconds or HTTP date) into milliseconds. */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize the outgoing message list for providers that are strict about
 * the tool-call shape (Groq rejects assistant tool_calls missing `type`;
 * OpenAI accepts the extra field). Deep-copies so the caller's message
 * objects are never mutated.
 */
function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.tool_calls || message.tool_calls.length === 0) {
      return message;
    }
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.function.name, arguments: call.function.arguments },
      })),
    };
  });
}

/**
 * Shape raw content + tool calls into a `CompletionResult`, applying the
 * text-embedded tool-call fallback for models that answer tool requests as
 * text. Shared by the streaming and non-streaming paths so they behave
 * identically.
 */
function finalizeCompletion(
  content: string | null,
  toolCalls: ToolCall[],
  finishReason: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): CompletionResult {
  let c = content;
  let calls = toolCalls;
  if (calls.length === 0 && typeof c === 'string') {
    const textCalls = parseTextToolCalls(c);
    if (textCalls.length > 0) {
      calls = textCalls;
      c = null;
    }
  }
  return { content: c, toolCalls: calls, finishReason, model, usage };
}

// ---------------------------------------------------------------------------
// Text-embedded tool calls (local / small models)
// ---------------------------------------------------------------------------

/**
 * Parse tool calls that a model emitted as text rather than a native
 * `tool_calls` field. Handles two shapes:
 *
 * 1. `<function/name>{…}</function>` / `<function(name)>{…}</function>` blocks
 *    (the format llama-3.x on Groq emits when it answers tool requests as
 *    text) — any number of calls, each with its own JSON arguments.
 * 2. A single `{ "name"|"tool"|"function": …, "arguments"|"parameters": … }` object
 *    (possibly fenced in ```json), as emitted by small local models.
 */
function parseTextToolCalls(content: string): ToolCall[] {
  const stripped = content.replace(/```(?:json)?/gi, '').trim();

  // 1. Multi-block <function/name> / <function(name)> format.
  const blocks = parseFunctionBlocks(stripped);
  if (blocks.length > 0) return blocks;

  // 2. Single JSON object (possibly embedded in prose).
  const candidates = [stripped];
  const obj = firstJsonObject(stripped);
  if (obj && obj !== stripped) candidates.push(obj);
  for (const candidate of candidates) {
    if (!candidate.includes('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const name = ['name', 'tool', 'function']
      .map((k) => record[k])
      .find((v): v is string => typeof v === 'string');
    if (!name) continue;
    const args = record['arguments'] ?? record['parameters'] ?? {};
    return [
      {
        id: `text-${Math.random().toString(36).slice(2, 10)}`,
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      },
    ];
  }
  return [];
}

/**
 * Extract every `<function/name>`, `<function(name)>`, `<function.name>`, or
 * `<function(name){` block (the text-tool-call syntax llama-3.x on Groq
 * emits) plus the JSON body. Handles the `>`-separated, brace-direct, and
 * `{…}`-only forms; a malformed block is skipped rather than failing the
 * whole parse.
 */
function parseFunctionBlocks(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  // Opening: <function then an optional /, (, ., or space separator, a name,
  // an optional ) and optional >, then a JSON object body (possibly with a
  // leading { already consumed by the separator match — brace-direct form).
  const blockRe =
    /<function\s*[/(.]?[\s]*([^)>{\s]+)[\s)]*[>]?(\{[\s\S]*?\})<\/function>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(content)) !== null) {
    const name = match[1]!.trim();
    const body = match[2]!.trim();
    if (name === '' || body === '') continue;
    let args: string;
    try {
      const parsed: unknown = JSON.parse(body);
      args = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch {
      // Not JSON — try to salvage a balanced object if one is embedded.
      const obj = firstJsonObject(body);
      if (!obj) continue;
      args = obj;
    }
    calls.push({
      id: `text-${Math.random().toString(36).slice(2, 10)}`,
      function: { name, arguments: args },
    });
  }
  return calls;
}

/** Extract the first balanced `{…}` object from text (nested braces + strings safe). */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
