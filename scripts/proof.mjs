// `npm run proof -- DC-<nr>`: records the proof video of one task. Runs
// test/e2e/proof/DC-<nr>.spec.ts in the `proof` Playwright project (video on,
// 1440x900, slowed down; see test/playwright.config.ts), then copies the single
// video it produced to test-results/proof/DC-<nr>.webm and prints its path.
// Playwright is started through node, never through a shebang script.
//
// Extra arguments go to Playwright (`npm run proof -- DC-35 --headed`).
// DIFFCITY_E2E_SKIP_BUILD=1 reuses an existing dist/.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [task, ...rest] = process.argv.slice(2);

if (task === undefined || !/^DC-\d+$/.test(task)) {
  console.error('usage: npm run proof -- DC-<nr> [playwright options]');
  process.exit(1);
}
const spec = join(root, 'test', 'e2e', 'proof', `${task}.spec.ts`);
if (!existsSync(spec)) {
  console.error(`no proof spec for ${task}: expected ${relative(root, spec)}`);
  process.exit(1);
}

const outDir = join(root, 'test-results', 'proof', task);
const target = join(root, 'test-results', 'proof', `${task}.webm`);
rmSync(outDir, { recursive: true, force: true });
rmSync(target, { force: true });

const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const run = spawnSync(
  process.execPath,
  [cli, 'test', '-c', 'test/playwright.config.ts', '--project=proof', `test/e2e/proof/${task}.spec.ts`, ...rest],
  { cwd: root, stdio: 'inherit', env: { ...process.env, DIFFCITY_PROOF: task } },
);
if (run.status !== 0) {
  console.error(`the ${task} proof spec failed (exit ${String(run.status ?? run.signal)})`);
  process.exit(run.status ?? 1);
}

/** Every .webm under `dir`. */
function videos(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return videos(path);
    return entry.name.endsWith('.webm') ? [path] : [];
  });
}

const found = videos(outDir);
if (found.length !== 1) {
  console.error(`expected 1 video under ${relative(root, outDir)}, found ${String(found.length)}`);
  for (const path of found) console.error(`  ${relative(root, path)}`);
  process.exit(1);
}
const [video] = found;
copyFileSync(video, target);
console.log(`video: ${video}`);
console.log(`proof: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
