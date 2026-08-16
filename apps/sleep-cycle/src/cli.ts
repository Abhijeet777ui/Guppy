#!/usr/bin/env node
/**
 * Sleep Cycle CLI — offline learning pass over the event store.
 *
 *   sleep-cycle analyze [--events <dir>] [--memory <dir>] [--out <file>]
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { runSleepCycle } from './index.js';

const program = new Command();

program
  .name('sleep-cycle')
  .description('Offline trajectory analysis: failure clustering + pattern reports')
  .version('1.0.0');

program
  .command('analyze')
  .description('Replay all sessions, cluster failures, and write the report')
  .option('--events <dir>', 'Event store root directory', '.guppy/events')
  .option('--memory <dir>', 'Memory store root directory', '.guppy/memory')
  .option('--out <file>', 'Report output path', '.guppy/sleep-cycle/report.md')
  .action(async (options) => {
    try {
      const result = await runSleepCycle({
        eventsRootDir: options.events,
        memoryRootDir: options.memory,
        outPath: options.out,
      });
      console.log(chalk.blue('[SleepCycle] Analysis complete'));
      console.log(chalk.gray(`  Sessions: ${result.report.sessionCount}`));
      console.log(chalk.gray(`  Failure clusters: ${result.report.clusters.length}`));
      const top = result.report.clusters[0];
      if (top) {
        console.log(
          chalk.gray(`  Most recurring: [${top.kind}] ${top.name} (${top.occurrences}x)`),
        );
      }
      console.log(chalk.green(`  Report written to ${result.outPath}`));
    } catch (e) {
      console.error(chalk.red('[SleepCycle] Failed:'), e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

program.parse();
