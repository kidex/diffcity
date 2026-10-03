// Prints the screens project's spec files for one CI shard, one per line:
// node scripts/e2e-shard.mjs <current> <total>
//
// Playwright's own --shard hands out contiguous blocks of files by test count,
// which puts the heavy change-screen specs (every one draws the city on
// SwiftShader) into the first shards. Dealing the sorted files round-robin
// spreads them, and a new spec under test/e2e/screens is picked up with no
// list to maintain.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'test', 'e2e', 'screens');

/** Every `*.spec.ts` under `dir`, as repo-relative posix paths, sorted. */
function specs(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...specs(path));
    else if (entry.name.endsWith('.spec.ts')) found.push(relative(root, path).split(sep).join('/'));
  }
  return found.sort();
}

const [current, total] = process.argv.slice(2).map(Number);
if (!Number.isInteger(current) || !Number.isInteger(total) || total < 1 || current < 1 || current > total) {
  console.error('usage: node scripts/e2e-shard.mjs <current> <total>');
  process.exit(2);
}
const mine = specs(dir).filter((_, index) => index % total === current - 1);
if (mine.length === 0) {
  console.error(`shard ${String(current)}/${String(total)} has no spec files`);
  process.exit(1);
}
console.log(mine.join('\n'));
