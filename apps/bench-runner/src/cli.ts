#!/usr/bin/env node
/**
 * guppy-bench — baseline measurement harness.
 *
 *   guppy-bench list                show the 20 controlled tasks
 *   guppy-bench sanity              validate every fixture (clean green, mutated red)
 *   guppy-bench run                 run configs across tasks and write the report
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { join, resolve } from 'node:path';
import { rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { BENCH_TASKS, sanityCheckTask, selectTasks } from './fixtures.js';
import {
  ALL_CONFIGS,
  effectiveRetrySettings,
  resolvePrimeBinary,
  runBench,
  type BenchConfigKind,
  type BenchOptions,
} from './runner.js';
import { writeReport } from './report.js';
import { attachContextHealth } from './context-health.js';
import { runCloseLoopDemo } from './loop-demo.js';
import { runSleepCycle } from '@guppy/sleep-cycle';

const program = new Command();

program
  .name('guppy-bench')
  .description('Baseline measurement: raw prime-agent vs guppy-wrapped on controlled tasks')
  .version('1.0.0');

program
  .command('list')
  .description('List all bench tasks')
  .action(() => {
    for (const task of BENCH_TASKS) {
      console.log(`${chalk.cyan(task.id.padEnd(32))} ${task.kind}`);
    }
    console.log(chalk.gray(`\n${BENCH_TASKS.length} tasks total`));
  });

program
  .command('sanity')
  .description('Validate fixtures: clean repo passes, mutated repo fails')
  .option('--out <dir>', 'Scratch directory', '.guppy/bench/sanity')
  .action(async (options: { out: string }) => {
    const scratchDir = resolve(options.out);
    let allOk = true;
    for (const spec of BENCH_TASKS) {
      const report = await sanityCheckTask(spec, scratchDir);
      allOk = allOk && report.ok;
      const mark = report.ok ? chalk.green('OK  ') : chalk.red('FAIL');
      console.log(`${mark} ${spec.id} — ${report.detail.split('\n')[0]}`);
      if (!report.ok) {
        console.log(chalk.gray(report.detail));
      }
    }
    rmSync(scratchDir, { recursive: true, force: true });
    if (!allOk) {
      process.exitCode = 1;
    }
  });

function parseConfigs(value: string): BenchConfigKind[] {
  const configs = value.split(',').map((v) => v.trim()) as BenchConfigKind[];
  for (const config of configs) {
    if (!ALL_CONFIGS.includes(config)) {
      throw new Error(`unknown config '${config}' (expected one of: ${ALL_CONFIGS.join(', ')})`);
    }
  }
  return configs;
}

/** Parse a numeric CLI option into a finite number, or undefined when absent/invalid. */
function optNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

program
  .command('run')
  .description('Run bench configs across tasks and write the report')
  .option('--config <list>', `Configs, comma-separated (${ALL_CONFIGS.join(', ')})`, ALL_CONFIGS.join(','))
  .option('--tasks <list>', 'Task ids / kinds / prefixes, comma-separated (default: all)')
  .option('--out <dir>', 'Output directory', '')
  .option('--model <id>', 'Model pattern passed to the runtimes', 'claude-3-5-sonnet')
  .option('--provider <name>', 'Model provider for the guppy-core runtime (openai, openrouter, nvidia, …)')
  .option('--base-url <url>', 'OpenAI-compatible API base URL for the guppy-core runtime')
  .option('--api-key <key>', 'API key for the guppy-core runtime (provider env var used when omitted)')
  .option('--wsl <distro>', 'Run prime-agent inside this WSL2 distro (Windows hosts)')
  .option('--prime-binary <path>', 'prime-agent binary path (defaults to the in-repo bundle)', resolvePrimeBinary())
  .option('--max-attempts <n>', 'Max closed-loop attempts per task (guppy configs)', '3')
  .option('--attempt-timeout <ms>', 'Per-attempt timeout in ms', '600000')
  .option('--max-retries <n>', 'Max retries per model request for guppy-core (429/5xx/network)')
  .option('--retry-base-delay <ms>', 'Initial backoff delay in ms for guppy-core')
  .option('--retry-max-delay <ms>', 'Max single backoff delay in ms for guppy-core')
  .option('--dry-run', 'Materialize fixtures and gate them; never invoke an LLM', false)
  .option('--contextops-python <path>', 'Python interpreter for ContextOps context-health scoring', 'python')
  .action(async (options: Record<string, string | boolean>) => {
    const outDir = resolve(
      typeof options['out'] === 'string' && options['out'] !== ''
        ? options['out']
        : join('.guppy', 'bench', new Date().toISOString().replace(/[:.]/g, '-')),
    );

    const maxRetries = optNumber(options['maxRetries']);
    const retryBaseDelayMs = optNumber(options['retryBaseDelay']);
    const retryMaxDelayMs = optNumber(options['retryMaxDelay']);

    const benchOptions: BenchOptions = {
      outDir,
      configs: parseConfigs(String(options['config'])),
      ...(typeof options['tasks'] === 'string' && options['tasks'] !== ''
        ? { taskFilter: String(options['tasks']).split(',').map((v) => v.trim()) }
        : {}),
      model: String(options['model']),
      ...(typeof options['provider'] === 'string' && options['provider'] !== ''
        ? { provider: String(options['provider']) }
        : {}),
      ...(typeof options['baseUrl'] === 'string' && options['baseUrl'] !== ''
        ? { baseUrl: String(options['baseUrl']) }
        : {}),
      ...(typeof options['apiKey'] === 'string' && options['apiKey'] !== ''
        ? { apiKey: String(options['apiKey']) }
        : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(retryBaseDelayMs !== undefined ? { retryBaseDelayMs } : {}),
      ...(retryMaxDelayMs !== undefined ? { retryMaxDelayMs } : {}),
      ...(typeof options['wsl'] === 'string' && options['wsl'] !== ''
        ? { wslDistro: String(options['wsl']) }
        : {}),
      ...(typeof options['primeBinary'] === 'string' && options['primeBinary'] !== ''
        ? { primeBinary: String(options['primeBinary']) }
        : {}),
      maxAttempts: parseInt(String(options['maxAttempts']), 10) || 3,
      // Commander camelizes --attempt-timeout to 'attemptTimeout'; guard NaN.
      attemptTimeoutMs: parseInt(String(options['attemptTimeout']), 10) || 600_000,
      dryRun: options['dryRun'] === true,
      ...(typeof options['contextopsPython'] === 'string' && options['contextopsPython'] !== ''
        ? { contextOpsPython: String(options['contextopsPython']) }
        : {}),
    };

    const tasks = selectTasks(benchOptions.taskFilter);
    console.log(chalk.bold('Guppy Bench'));
    console.log(chalk.gray(`  Out:      ${outDir}`));
    console.log(chalk.gray(`  Configs:  ${benchOptions.configs.join(', ')}`));
    console.log(chalk.gray(`  Tasks:    ${tasks.length}`));
    console.log(chalk.gray(`  Model:    ${benchOptions.model}`));
    console.log(chalk.gray(`  Attempts: ${benchOptions.maxAttempts}`));
    const retry = effectiveRetrySettings(benchOptions);
    console.log(
      chalk.gray(
        `  Retries (guppy-core): ${retry.maxRetries} (base ${retry.baseDelayMs}ms, max ${retry.maxDelayMs}ms)`,
      ),
    );
    if (benchOptions.dryRun) {
      console.log(chalk.yellow('  Mode:     dry-run (no LLM calls)'));
    }

    const results = await runBench(benchOptions);
    if (!benchOptions.dryRun) {
      await attachContextHealth(results, benchOptions);
    }
    const { reportPath, jsonPath } = writeReport(results, benchOptions);

    const passed = results.filter((r) => r.passed).length;
    let done = `\nDone: ${passed}/${results.length} passed. Report: ${reportPath} | Data: ${jsonPath}`;
    const scored = results.filter((r) => r.contextHealth && !r.contextHealth.skipped);
    if (scored.length > 0) {
      const saved = scored.reduce((a, r) => a + (r.contextHealth?.tokensSaved ?? 0), 0);
      const tool = scored.find((r) => r.contextHealth?.tool)?.contextHealth?.tool ?? 'contextops';
      done += ` | Tokens saved (${tool}, est.): ${saved}`;
    }
    console.log(chalk.bold(done));
  });

program
  .command('loop-demo')
  .description('Deterministic close-the-loop demo: gate fails, context adjusts, agent recovers')
  .option('--task <id>', 'Bench task to run the demo on', 'bugfix-clamp')
  .option('--out <dir>', 'Output directory', '.guppy/bench/loop-demo')
  .action(async (options: { task: string; out: string }) => {
    const outDir = resolve(options.out);
    console.log(chalk.bold('Guppy close-the-loop demo'));
    console.log(chalk.gray(`  Task: ${options.task}`));
    console.log(chalk.gray(`  Out:  ${outDir}\n`));

    const report = await runCloseLoopDemo({ outDir, taskId: options.task });

    for (const step of report.steps) {
      console.log(
        `  attempt ${step.attempt}: gate=${step.gatePassed ? chalk.green('PASS') : chalk.red('FAIL')} ` +
          `suite=${step.suiteGreen ? chalk.green('green') : chalk.red('red')} ` +
          chalk.gray(
            `(context: ${step.contextFiles} files, ${step.contextErrors} errors, ${step.contextTestResults} failed tests)`,
          ),
      );
    }

    console.log('');
    console.log(`  gate fired on attempt 1:   ${report.gateFiredOnAttempt1 ? chalk.green('yes') : chalk.red('no')}`);
    console.log(`  context adjusted attempt 2: ${report.contextAdjustedOnAttempt2 ? chalk.green('yes') : chalk.red('no')}`);
    console.log(`  agent recovered:           ${report.recovered ? chalk.green('yes') : chalk.red('no')}`);
    console.log(`  final suite green:         ${report.finalSuiteGreen ? chalk.green('yes') : chalk.red('no')}`);
    console.log(`  run 1 memory empty:        ${report.run1MemoryEmpty ? chalk.green('yes') : chalk.red('no')}`);
    console.log(`  run 2 retrieved run 1 fix: ${report.run2MemoryRetrieved ? chalk.green('yes') : chalk.red('no')}`);
    console.log(chalk.gray(`  event evidence: ${JSON.stringify(report.eventCounts)}`));
    console.log('');
    console.log(report.passed ? chalk.green.bold('CLOSE-THE-LOOP DEMO PASSED') : chalk.red.bold('CLOSE-THE-LOOP DEMO FAILED'));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('sleep-cycle')
  .description('Analyze bench event logs: cluster failures, write the pattern report')
  .option('--events <dir>', 'Event store root directory', '')
  .option('--memory <dir>', 'Memory store root directory', '')
  .option('--out <file>', 'Report output path', '.guppy/sleep-cycle/report.md')
  .action(async (options: { events: string; memory: string; out: string }) => {
    // Default: analyze the most recent bench run's event store + memory.
    // Explicit --events/--memory flags win over the discovered default.
    const latestRun = latestBenchRunDir();
    const result = await runSleepCycle({
      ...(latestRun
        ? { eventsRootDir: join(latestRun, 'events'), memoryRootDir: join(latestRun, 'memory') }
        : {}),
      ...(options.events !== '' ? { eventsRootDir: options.events } : {}),
      ...(options.memory !== '' ? { memoryRootDir: options.memory } : {}),
      outPath: resolve(options.out),
    });
    console.log(chalk.bold('Sleep cycle analysis'));
    console.log(chalk.gray(`  Sessions:        ${result.report.sessionCount}`));
    console.log(chalk.gray(`  Failure clusters: ${result.report.clusters.length}`));
    const top = result.report.clusters[0];
    if (top) {
      console.log(chalk.gray(`  Most recurring:  [${top.kind}] ${top.name} (${top.occurrences}x)`));
    }
    console.log(chalk.green(`  Report: ${result.outPath}`));
  });

/** Most recently modified `.guppy/bench/<run>` directory that recorded events. */
function latestBenchRunDir(): string | undefined {
  const benchRoot = resolve(join('.guppy', 'bench'));
  if (!existsSync(benchRoot)) return undefined;

  let latest: { path: string; mtimeMs: number } | undefined;
  for (const entry of readdirSync(benchRoot)) {
    const dir = join(benchRoot, entry);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || !existsSync(join(dir, 'events'))) continue;
    if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { path: dir, mtimeMs: stat.mtimeMs };
  }
  return latest?.path;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
