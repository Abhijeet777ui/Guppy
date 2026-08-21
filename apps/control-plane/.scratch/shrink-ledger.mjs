// Shrink the longhorizon-ledger fixture's data array so the initial model
// request fits Groq free's 8k TPM cap, while keeping the seeded bug
// (acc + e.amount, 1) and the deterministic first-three-amounts test.
// Usage: node .scratch/shrink-ledger.mjs <fixtureDir> [entries=200]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const entries = Number(process.argv[3] ?? 200);
const path = join(dir, 'src', 'ledger.ts');

const header = `export interface LedgerEntry {
  id: string;
  amount: number;
}

export function sumBalances(entries: LedgerEntry[]): number {
  return entries.reduce((acc, e) => acc + e.amount, 1);
}

export const LEDGER: LedgerEntry[] = [
`;
const lines = [];
let seed = 0x2f6e2b1;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed % 10_000;
};
for (let i = 1; i <= entries; i++) {
  const id = `tx-${String(i).padStart(8, '0')}`;
  lines.push(`  { id: '${id}', amount: ${rand()} },`);
}
const body = lines.join('\n');
writeFileSync(path, `${header}${body}\n];\n`, 'utf8');
console.log(`wrote ${path} (${entries} entries, ${readFileSync(path, 'utf8').length} bytes)`);
