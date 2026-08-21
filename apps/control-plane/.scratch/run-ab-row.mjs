// One compression A/B row on the longhorizon-ledger fixture.
// Usage: node .scratch/run-ab-row.mjs <none|llm|baseline> <budget>
//   baseline → --max-history-tokens 0 (never compress)
//   none     → --max-history-tokens <budget> --history-summary none
//   llm      → --max-history-tokens <budget> --history-summary llm
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const budget = Number(process.argv[3] ?? 1000);
const FIX = 'apps/control-plane/.guppy/live/compression-ab/fixture';
const CLI = 'apps/control-plane/dist/cli.js';

const args = ['apps/control-plane/dist/cli.js', 'run',
  'Run npm test, then fix src/ledger.ts so sumBalances is correct. Do not modify anything under test/.',
  '--repo', FIX, '--local', '--no-commit', '--model', 'qwen/qwen3.6-27b', '--provider', 'groq',
  '--max-retries', '8', '--retry-base-delay', '2000', '-t', '20', '--no-mcp', '--no-subagents'];

if (mode === 'baseline') args.push('--max-history-tokens', '0');
else {
  args.push('--max-history-tokens', String(budget));
  if (mode === 'llm') args.push('--history-summary', 'llm');
}

const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
const compressLines = out.split('\n').filter((l) => l.includes('compressed'));
const summary = out.split('\n').filter((l) => /Outcome:|Duration:|Tokens:|Tool calls:/.test(l));

// Per-request est tokens from the context captures written by this run.
const ctxDir = join(FIX, '.guppy', 'context');
let perRequest = [];
let totalEst = 0;
try {
  const files = readdirSync(ctxDir).filter((f) => f.endsWith('.json')).sort();
  perRequest = files.map((f) => {
    const p = JSON.parse(readFileSync(join(ctxDir, f), 'utf8'));
    const est = Math.round(JSON.stringify(p.messages).length / 4);
    totalEst += est;
    return est;
  });
} catch {}

console.log(`\n=== ROW ${mode} (budget ${budget}) ===`);
console.log('compressions:', compressLines.length);
for (const l of compressLines) console.log('  ' + l);
console.log('per-request est tokens:', perRequest.join(', '));
console.log('TOTAL est tokens sent:', totalEst);
for (const l of summary) console.log(l.trim());
