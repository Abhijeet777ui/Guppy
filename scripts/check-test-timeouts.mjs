/**
 * CI guard: every vitest test script must declare an explicit test timeout.
 *
 * The 5000ms vitest default is the flake class that broke cold clones and
 * macOS CI: process-spawning tests (workspace dep provisioning, core
 * subagent e2e, bench materialization) blow past it under `pnpm -r run test`
 * parallel load, and the failure only surfaces on a cold machine or a fast
 * runner. Requiring an explicit `--testTimeout=` per package forces a
 * deliberate choice instead of the silent default.
 *
 * Fast unit suites may declare `--testTimeout=5000` (explicit beats default);
 * process-spawning suites need 15000+ (see the TIMEOUT CONTRACT comments in
 * the affected test files).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const offenders = [];
for (const root of ['packages', 'apps']) {
  for (const name of readdirSync(root)) {
    const pkgPath = join(root, name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const test = pkg.scripts?.test;
    if (!test || !test.includes('vitest')) continue;
    if (!test.includes('--testTimeout=')) {
      offenders.push(`${root}/${name}: ${test}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    '[check-test-timeouts] FAIL: these vitest test scripts rely on the 5000ms default:',
  );
  for (const o of offenders) console.error('  ' + o);
  console.error(
    'Add an explicit --testTimeout=... to each (fast unit suites: --testTimeout=5000; process-spawning suites: 15000+).',
  );
  process.exit(1);
}
console.log('[check-test-timeouts] all vitest test scripts declare an explicit testTimeout');
