#!/usr/bin/env node
// Removes build output before a build, so a renamed or deleted source file
// leaves no orphan .js behind in the package.
//
//   node scripts/clean-dist.mjs          removes the whole dist/
//   node scripts/clean-dist.mjs --node   removes dist/ except dist/ui (the Vite
//                                        build empties dist/ui itself), so
//                                        build:node can run without the UI build
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

if (process.argv.includes('--node')) {
  let entries = [];
  try {
    entries = readdirSync(dist);
  } catch {
    // No dist/ yet: nothing to clean.
  }
  for (const entry of entries) {
    if (entry !== 'ui') rmSync(join(dist, entry), { recursive: true, force: true });
  }
} else {
  rmSync(dist, { recursive: true, force: true });
}
