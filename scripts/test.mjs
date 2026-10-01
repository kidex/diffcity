#!/usr/bin/env node
// `npm test`: runs the vitest projects one after the other, `main` and then
// `timing` (the 5 s deadline tests, alone on the machine; see vitest.config.ts).
// Vitest is started through node, never through a shebang script (slow process
// spawns on macOS). Arguments go to both runs:
//
//   npm test                                   main, then timing
//   npm test -- test/integration/collect       both, each limited to those files
//   npm test -- --project timing               only that project
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const args = process.argv.slice(2);

/** Runs vitest once and returns its exit code. */
function run(extra) {
  const result = spawnSync(process.execPath, [vitest, 'run', ...extra, ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

if (args.some((arg) => arg === '--project' || arg.startsWith('--project='))) process.exit(run([]));

// With file filters, one of the projects may have no matching file.
const filtered = args.some((arg) => !arg.startsWith('-'));
const extra = filtered ? ['--passWithNoTests'] : [];
const main = run(['--project', 'main', ...extra]);
if (main !== 0) process.exit(main);
process.exit(run(['--project', 'timing', ...extra]));
