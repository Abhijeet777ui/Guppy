/**
 * Deterministic long-horizon compression measurement — drives the REAL
 * CoreAgentRuntime turn loop with a scripted fake model (no network, no cost)
 * and measures the actual tokens sent to the model in each request payload
 * (chars/4, the same estimator the compressor uses).
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, now } from '@guppy/contracts';
import { createEventStore } from '@guppy/event-store';
import { createWorkspaceManager } from '@guppy/workspace';
import { createCoreRuntime, estimateMessageTokens, COMPRESSED_HISTORY_HEADER } from '@guppy/core';

const TOOL_TURNS = 24; // a long-horizon task: 24 tool calls of big results

function toolChoice(id, name, args) {
  return {
    model: 'fake/nemotron',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function startMock(responses) {
  const requests = [];
  let i = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c.toString('utf8')));
    req.on('end', () => {
      requests.push({ body: JSON.parse(raw || '{}') });
      const body = responses[Math.min(i, responses.length - 1)] ?? { choices: [] };
      i++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  return { server, requests, url: '' };
}

async function run(label, maxHistoryTokens) {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-compress-measure-'));
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(fixtureDir, { recursive: true });
  // Big file: every read_file returns a large (20k-truncated) tool result.
  writeFileSync(join(fixtureDir, 'big.txt'), 'z'.repeat(60_000), 'utf8');

  const responses = [];
  for (let t = 0; t < TOOL_TURNS; t++) {
    responses.push(toolChoice(`call-${t}`, 'read_file', { path: 'big.txt' }));
  }
  responses.push({
    model: 'fake/nemotron',
    choices: [{ message: { role: 'assistant', content: 'Done.', finish_reason: 'stop' } }],
    usage: { prompt_tokens: 100, completion_tokens: 8 },
  });

  const mock = startMock(responses);
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  mock.url = `http://127.0.0.1:${mock.server.address().port}/v1`;

  try {
    const eventStore = createEventStore({ rootDir: join(dir, 'events'), sqliteIndex: false });
    const wm = createWorkspaceManager({ useContainers: false, worktreeBase: join(dir, 'worktrees') });
    const workspace = (await wm.createWorkspace(fixtureDir)).value;

    const runtime = createCoreRuntime({
      eventStore,
      workspaceManager: wm,
      model: { provider: 'fake', model: 'fake/nemotron', baseUrl: mock.url },
      maxTurns: 40,
      ...(maxHistoryTokens >= 0 ? { maxHistoryTokens, historyKeepRecentTurns: 1 } : {}),
    });
    await runtime.initialize(workspace);

    const task = { id: ulid(), description: 'Make the big file pass the checks. It does not.', repoPath: 'repo' };
    const context = {
      taskId: task.id,
      sessionId: ulid(),
      files: [],
      testResults: [],
      errors: [],
      memories: [],
      skills: [],
      tokensUsed: 0,
      maxTokens: 0,
      selectedAt: now(),
      selectionReasoning: '',
    };
    const result = await runtime.run(task, context);

    // Measure the payload tokens actually sent per request (chars/4).
    const perRequest = mock.requests.map((r) => estimateMessageTokens(r.body.messages ?? []));
    const tokensSent = perRequest.reduce((a, b) => a + b, 0);
    const compressions = (result.value?.events ?? []).filter((e) => e.type === 'ContextCompressed').length;
    const lastRequest = perRequest[perRequest.length - 1] ?? 0;

    await eventStore.close();
    await wm.destroyWorkspace(workspace.id);

    return { label, tokensSent, requests: perRequest.length, compressions, lastRequest, maxPayload: Math.max(...perRequest, 0) };
  } finally {
    mock.server.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
  }
}

const baseline = await run('never-compress (budget 0)', 0);
const compressed = await run('compress (budget 12000)', 12_000);

console.log('\n=== LONG-HORIZON COMPRESSION MEASUREMENT ===');
console.log(`(scripted ${TOOL_TURNS}-turn run, big tool results, real turn loop, no model cost)\n`);
for (const r of [baseline, compressed]) {
  console.log(
    `${r.label.padEnd(32)} tokens sent: ${r.tokensSent.toLocaleString()}  requests: ${r.requests}  ` +
      `max single payload: ${r.maxPayload.toLocaleString()}  last payload: ${r.lastRequest.toLocaleString()}  compressions: ${r.compressions}`,
  );
}
const delta = baseline.tokensSent - compressed.tokensSent;
const pct = baseline.tokensSent > 0 ? ((delta / baseline.tokensSent) * 100).toFixed(1) : '0';
console.log(`\nSAVINGS: ${delta.toLocaleString()} tokens (${pct}% fewer tokens sent to the model)`);
