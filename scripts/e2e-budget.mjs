#!/usr/bin/env node
// Fails when the Playwright specs outgrow the CI budget: the screens project is
// sharded over 12 jobs (scripts/e2e-shard.mjs), so more files mean longer
// shards. The numbers go up only with a plan revision.
//
//   node scripts/e2e-budget.mjs

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = { screens: 180, acceptance: 10 };

const root = fileURLToPath(new URL('../', import.meta.url));

/** Number of `*.spec.ts` files under `folder`. @param {string} folder @returns {number} */
export function countSpecs(folder) {
  let count = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countSpecs(join(folder, entry.name));
    else if (entry.name.endsWith('.spec.ts')) count++;
  }
  return count;
}

/**
 * The projects over their limit, as messages.
 * @param {{ screens: number, acceptance: number }} counts
 * @param {{ screens: number, acceptance: number }} [limits]
 * @returns {string[]}
 */
export function overBudget(counts, limits = LIMITS) {
  /** @type {string[]} */
  const over = [];
  for (const project of /** @type {const} */ (['screens', 'acceptance'])) {
    if (counts[project] > limits[project]) {
      over.push(`${project}: ${String(counts[project])} spec files, the budget is ${String(limits[project])}`);
    }
  }
  return over;
}

function main() {
  const counts = {
    screens: countSpecs(join(root, 'test', 'e2e', 'screens')),
    acceptance: countSpecs(join(root, 'test', 'e2e', 'acceptance')),
  };
  console.log(`screens: ${String(counts.screens)}/${String(LIMITS.screens)}, acceptance: ${String(counts.acceptance)}/${String(LIMITS.acceptance)}`);
  const over = overBudget(counts);
  for (const line of over) console.error(`::error::e2e budget exceeded, ${line}. Raising it needs a plan revision.`);
  if (over.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
