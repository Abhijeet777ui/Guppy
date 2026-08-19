import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  OpenAIChatClient,
  RateLimiter,
  resolveBaseUrl,
  type ChatMessage,
  type ToolDefinition,
} from '../src/index.js';

interface CapturedRequest {
  body: Record<string, unknown>;
  auth: string | undefined;
}

function startMock(
  status: number,
  body: unknown,
): { server: Server; url: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ body: JSON.parse(raw || '{}'), auth: req.headers.authorization });
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  return { server, url: '', requests };
}

interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Serve a scripted sequence of responses in order (the last one repeats once
 * exhausted). Lets retry tests assert on exactly how many requests were made.
 */
function startSequenceMock(
  responses: MockResponse[],
): { server: Server; url: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  let index = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({ body: JSON.parse(raw || '{}'), auth: req.headers.authorization });
      const response = responses[Math.min(index, responses.length - 1)];
      index++;
      if (!response) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'mock sequence exhausted' } }));
        return;
      }
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        res.setHeader(key, value);
      }
      res.end(JSON.stringify(response.body ?? {}));
    });
  });
  return { server, url: '', requests };
}

/** Serve a scripted SSE stream: each chunk becomes one `data:` event, then [DONE]. */
function startStreamMock(
  chunks: Array<Record<string, unknown>>,
): { server: Server; url: string; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ body: JSON.parse(raw || '{}'), auth: req.headers.authorization });
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, url: '', requests };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const READ_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

describe('OpenAIChatClient', () => {
  it('sends messages+tools and parses content, tool calls, and usage', async () => {
    const { server, requests } = startMock(200, {
      model: 'fake/nemotron',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        apiKey: 'sk-test',
        maxTokens: 512,
      });

      const messages: ChatMessage[] = [{ role: 'user', content: 'read the file' }];
      const result = await client.complete(messages, [READ_TOOL]);

      expect(result.content).toBeNull();
      expect(result.model).toBe('fake/nemotron');
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.function.name).toBe('read_file');
      expect(result.toolCalls[0]!.function.arguments).toBe('{"path":"src/a.ts"}');

      const req = requests[0]!;
      expect(req.auth).toBe('Bearer sk-test');
      expect(req.body.model).toBe('fake/nemotron');
      expect(req.body.max_tokens).toBe(512);
      expect(req.body.messages).toEqual([{ role: 'user', content: 'read the file' }]);
      expect(req.body.tools).toHaveLength(1);
      expect((req.body.tool_choice as string)).toBe('auto');
    } finally {
      await close(server);
    }
  });

  it('merges extraBody fields into the request without overriding reserved keys', async () => {
    const { server, requests } = startMock(200, {
      model: 'fake/reasoner',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/reasoner',
        baseUrl: url,
        extraBody: { reasoning_effort: 'high', model: 'fake/must-not-win' },
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const body = requests[0]!.body;
      expect(body.reasoning_effort).toBe('high');
      // Reserved keys are emitted by the client after extraBody, so they win.
      expect(body.model).toBe('fake/reasoner');
    } finally {
      await close(server);
    }
  });

  it('returns text content when the model answers directly', async () => {
    const { server } = startMock(200, {
      model: 'fake/nemotron',
      choices: [
        { message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({ provider: 'fake', model: 'fake/nemotron', baseUrl: url });
      const result = await client.complete([{ role: 'user', content: 'hi' }]);
      expect(result.content).toBe('done');
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe('stop');
    } finally {
      await close(server);
    }
  });

  it('parses a fenced-JSON tool call when a model emits it as text', async () => {
    const { server } = startMock(200, {
      model: 'qwen2.5-coder:1.5b',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '```json\n{"name": "run_command", "arguments": {"command": "npm test"}}\n```',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 9 },
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'qwen2.5-coder:1.5b',
        baseUrl: url,
      });
      const result = await client.complete([{ role: 'user', content: 'run tests' }], [READ_TOOL]);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.function.name).toBe('run_command');
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ command: 'npm test' });
      expect(result.content).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('throws a descriptive error on non-2xx responses', async () => {
    const { server } = startMock(401, { error: { message: 'bad key' } });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({ provider: 'fake', model: 'fake/nemotron', baseUrl: url });
      await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/HTTP 401/);
    } finally {
      await close(server);
    }
  });

  it('retries on 429 with backoff and eventually succeeds', async () => {
    const { server, requests } = startSequenceMock([
      { status: 429, body: { error: { message: 'rate limited' } } },
      { status: 429, body: { error: { message: 'rate limited' } } },
      {
        status: 200,
        body: {
          model: 'fake/nemotron',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 1 },
        },
      },
    ]);
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        maxRetries: 2,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 5,
      });

      const result = await client.complete([{ role: 'user', content: 'hi' }]);

      expect(result.content).toBe('ok');
      expect(requests).toHaveLength(3);
    } finally {
      await close(server);
    }
  });

  it('gives up with the last error after exhausting retries', async () => {
    const { server, requests } = startSequenceMock([
      { status: 500, body: { error: { message: 'boom' } } },
      { status: 500, body: { error: { message: 'boom' } } },
    ]);
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        maxRetries: 1,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 5,
      });

      await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/HTTP 500/);
      expect(requests).toHaveLength(2);
    } finally {
      await close(server);
    }
  });

  it('does not retry client errors (4xx other than 429)', async () => {
    const { server, requests } = startSequenceMock([
      { status: 401, body: { error: { message: 'bad key' } } },
    ]);
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        maxRetries: 3,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 5,
      });

      await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/HTTP 401/);
      expect(requests).toHaveLength(1);
    } finally {
      await close(server);
    }
  });

  it('honors a Retry-After header when retrying', async () => {
    const { server, requests } = startSequenceMock([
      { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } },
      {
        status: 200,
        body: {
          model: 'fake/nemotron',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      },
    ]);
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        maxRetries: 1,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 5000,
      });

      const result = await client.complete([{ role: 'user', content: 'hi' }]);

      expect(result.content).toBe('ok');
      expect(requests).toHaveLength(2);
    } finally {
      await close(server);
    }
  });

  it('retries after a network error (connection drops) and succeeds', async () => {
    let attempts = 0;
    const server = createServer((req, res) => {
      attempts++;
      if (attempts === 1) {
        // Kill the socket before writing a response so fetch rejects.
        req.socket.destroy();
        return;
      }
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            model: 'fake/nemotron',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      });
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        maxRetries: 2,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 5,
      });

      const result = await client.complete([{ role: 'user', content: 'hi' }]);

      expect(result.content).toBe('ok');
      expect(attempts).toBe(2);
    } finally {
      await close(server);
    }
  });

  it('streams content deltas and returns the accumulated result', async () => {
    const { server, requests } = startStreamMock([
      { model: 'fake/nemotron', choices: [{ delta: { content: 'Hello ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]);
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({ provider: 'fake', model: 'fake/nemotron', baseUrl: url });

      const seen: string[] = [];
      const result = await client.completeStream(
        [{ role: 'user', content: 'hi' }],
        undefined,
        (text) => seen.push(text),
      );

      expect(result.content).toBe('Hello world');
      expect(result.toolCalls).toEqual([]);
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
      expect(seen).toEqual(['Hello ', 'Hello world']);
      expect(requests[0]!.body.stream).toBe(true);
    } finally {
      await close(server);
    }
  });

  it('stitches tool-call fragments together across stream deltas', async () => {
    const { server } = startStreamMock([
      {
        model: 'fake/nemotron',
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_', arguments: '{"pa' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"src/a.ts"}' } }] }, finish_reason: 'tool_calls' },
        ],
      },
    ]);
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({ provider: 'fake', model: 'fake/nemotron', baseUrl: url });
      const result = await client.completeStream([{ role: 'user', content: 'read it' }], [READ_TOOL]);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.function.name).toBe('read_file');
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ path: 'src/a.ts' });
    } finally {
      await close(server);
    }
  });

  it('applies the fenced-JSON tool-call fallback to a streamed text answer', async () => {
    const json = '{"name": "run_command", "arguments": {"command": "npm test"}}';
    const { server } = startStreamMock([
      { model: 'qwen2.5-coder:1.5b', choices: [{ delta: { content: '```json\n' }, finish_reason: null }] },
      { choices: [{ delta: { content: json }, finish_reason: null }] },
      { choices: [{ delta: { content: '\n```' }, finish_reason: 'stop' }] },
    ]);
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({ provider: 'fake', model: 'qwen2.5-coder:1.5b', baseUrl: url });
      const result = await client.completeStream([{ role: 'user', content: 'run tests' }], [READ_TOOL]);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.function.name).toBe('run_command');
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ command: 'npm test' });
      expect(result.content).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('parses <function/name>{...}</function> blocks a model emits as text (Groq llama-3.x style)', async () => {
    const content = [
      '<function/run_command>{"command":["npm","test"]}</function>',
      '<function/read_file>{"path":"src/math-utils.ts"}</function>',
      '<function/apply_patch>{"patch":"--- a/src/math-utils.ts\n+++ b/src/math-utils.ts\n@@ -1 +1 @@\n"}</function>',
    ].join('\n');
    const { server } = startMock(200, {
      model: 'llama-3.3-70b-versatile',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 9 },
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'llama-3.3-70b-versatile',
        baseUrl: url,
      });
      const result = await client.complete([{ role: 'user', content: 'fix the bug' }], [READ_TOOL]);
      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls.map((c) => c.function.name)).toEqual([
        'run_command',
        'read_file',
        'apply_patch',
      ]);
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ command: ['npm', 'test'] });
      expect(result.content).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('parses the <function(name)> sibling syntax and skips malformed blocks', async () => {
    const content = [
      'Let me check the file first.',
      '<function(run_command)>{"command":["cat","src/a.ts"]}</function>',
      '<function(write_file)>not-json</function>',
      '<function(read_file)>{"path":"src/b.ts"}</function>',
    ].join('\n');
    const { server } = startMock(200, {
      model: 'llama-3.3-70b-versatile',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 9 },
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'llama-3.3-70b-versatile',
        baseUrl: url,
      });
      const result = await client.complete([{ role: 'user', content: 'fix it' }], [READ_TOOL]);
      expect(result.toolCalls.map((c) => c.function.name)).toEqual(['run_command', 'read_file']);
      expect(result.content).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('parses brace-direct <function(name){…} and dot <function.name> variants', async () => {
    const content = [
      '<function(run_command){"command":["npm","test"]}</function>',
      '<function.run_command>{"command":["npm","run","build"]}</function>',
    ].join('\n');
    const { server } = startMock(200, {
      model: 'llama-3.3-70b-versatile',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 9 },
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'llama-3.3-70b-versatile',
        baseUrl: url,
      });
      const result = await client.complete([{ role: 'user', content: 'fix it' }], [READ_TOOL]);
      expect(result.toolCalls.map((c) => c.function.name)).toEqual(['run_command', 'run_command']);
      expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ command: ['npm', 'test'] });
      expect(JSON.parse(result.toolCalls[1]!.function.arguments)).toEqual({ command: ['npm', 'run', 'build'] });
      expect(result.content).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('adds type:function to assistant tool_calls when sending history back (Groq requires it)', async () => {
    const { server, requests } = startMock(200, {
      model: 'llama-3.3-70b-versatile',
      choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 9 },
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'llama-3.3-70b-versatile',
        baseUrl: url,
      });
      const history: ChatMessage[] = [
        { role: 'user', content: 'fix the bug' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: 'ok' },
      ];
      await client.complete(history, [READ_TOOL]);

      const sent = requests[0]!.body.messages as Array<{ role: string; tool_calls?: Array<Record<string, unknown>> }>;
      const assistant = sent.find((m) => m.role === 'assistant');
      expect(assistant!.tool_calls![0]).toMatchObject({ id: 'call-1', type: 'function' });
      // Original objects untouched (no mutation).
      expect((history[1]!.tool_calls![0] as Record<string, unknown>)['type']).toBeUndefined();
    } finally {
      await close(server);
    }
  });

  it('times out a hung request instead of hanging forever', async () => {
    const server = createServer(() => {
      // Accept the connection but never send a response — the client must give
      // up on its own timeout rather than hang.
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        timeoutMs: 150,
        maxRetries: 0,
      });
      const startedAt = Date.now();
      await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it('gives up on a stream that sends headers then stalls (idle timeout)', async () => {
    const server = createServer((_req, res) => {
      // Headers first (so the request-timeout path is already cleared), then
      // silence — the classic mid-stream stall. The idle timeout must surface
      // it instead of hanging forever.
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        timeoutMs: 60_000, // Long pre-headers timeout proves the idle path fires
        streamIdleTimeoutMs: 150,
        maxRetries: 0,
      });
      const startedAt = Date.now();
      await expect(client.completeStream([{ role: 'user', content: 'hi' }])).rejects.toThrow(/stalled/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it('gives up on a non-streaming body that stalls after headers', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.flushHeaders();
      // Never write the body: response.json() would hang without the idle race.
    });
    const url = await listen(server);
    try {
      const client = new OpenAIChatClient({
        provider: 'fake',
        model: 'fake/nemotron',
        baseUrl: url,
        timeoutMs: 60_000,
        streamIdleTimeoutMs: 150,
        maxRetries: 0,
      });
      const startedAt = Date.now();
      await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/stalled/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });
});

describe('RateLimiter', () => {
  it('paces requests under the RPM cap within a 60s window', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter();
      const key = 'fake|http://limit/v1';

      const first = limiter.acquire(key, 2);
      const second = limiter.acquire(key, 2);
      const third = limiter.acquire(key, 2);

      await first;
      await second;

      let thirdDone = false;
      void third.then(() => {
        thirdDone = true;
      });

      // The first two slots are consumed immediately; the third must wait for
      // the window to slide before it can proceed.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(thirdDone).toBe(false);

      await vi.advanceTimersByTimeAsync(1_100);
      expect(thirdDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throttle when rpm is unset or zero', async () => {
    const limiter = new RateLimiter();
    const startedAt = Date.now();
    await limiter.acquire('fake|http://x/v1', undefined);
    await limiter.acquire('fake|http://x/v1', 0);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});

describe('resolveBaseUrl — provider base-URL mapping', () => {
  it('maps known providers to their OpenAI-compatible endpoints', () => {
    expect(resolveBaseUrl({ provider: 'openrouter', model: 'x' })).toBe('https://openrouter.ai/api/v1');
    expect(resolveBaseUrl({ provider: 'groq', model: 'x' })).toBe('https://api.groq.com/openai/v1');
    expect(resolveBaseUrl({ provider: 'nvidia', model: 'x' })).toBe('https://integrate.api.nvidia.com/v1');
  });

  it('an explicit baseUrl always wins over the provider map', () => {
    expect(resolveBaseUrl({ provider: 'openrouter', model: 'x', baseUrl: 'http://127.0.0.1:9999/v1/' })).toBe(
      'http://127.0.0.1:9999/v1',
    );
  });

  it('unknown providers fall back to the OpenAI default', () => {
    expect(resolveBaseUrl({ provider: 'mystery', model: 'x' })).toBe('https://api.openai.com/v1');
  });
});
