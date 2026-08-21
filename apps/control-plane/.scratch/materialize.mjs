// Materialize a bench fixture (red state) into a directory.
// Usage: node .scratch/materialize.mjs <taskId> <destDir>
import { materializeFixture, getTask } from '../../../apps/bench-runner/dist/index.js';
const taskId = process.argv[2];
const dest = process.argv[3];
const spec = getTask(taskId);
if (!spec) {
  console.error(`unknown task: ${taskId}`);
  process.exit(1);
}
materializeFixture(spec, dest);
console.log(`materialized ${taskId} → ${dest}`);
