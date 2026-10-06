#!/usr/bin/env node
// Measures what the call graph (ADR-034) adds to a collect, on a synthetic
// change of N touched TS files (default 300) built in memory.
//
//   npm run build:node
//   node scripts/measure-graph.mjs [--files 300] [--runs 20]
//
// Prints the time of the symbol comparison the report already pays for, the
// first graph build (it includes loading ts-morph, once per worker) and the
// median and p95 of the following builds. No repo, no disk: invented sources.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { compareFileWithFingerprints } = await import(pathToFileURL(join(dist, 'core', 'diff', 'status.js')).href);
const { buildCallGraph } = await import(pathToFileURL(join(dist, 'core', 'path', 'graph.js')).href);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const count = option('--files', 300);
const runs = option('--runs', 20);

/** One file: a class and three functions, calling into the next few files. */
function source(i, version) {
  const imports = [1, 2, 3].map((d) => (i + d) % count);
  const lines = imports.map((j) => `import { fn${j}a, Svc${j} } from './m${j}';`);
  lines.push('');
  lines.push(`export class Svc${i} {`);
  lines.push(`  run(x: number): number {`);
  lines.push(`    return new Svc${imports[0]}().run(x) + ${version};`);
  lines.push('  }');
  lines.push('}');
  for (const suffix of ['a', 'b', 'c']) {
    lines.push('');
    lines.push(`export function fn${i}${suffix}(x: number): number {`);
    lines.push(`  const total = ${imports.map((j) => `fn${j}a(x)`).join(' + ')};`);
    lines.push(`  return total + ${version};`);
    lines.push('}');
  }
  return `${lines.join('\n')}\n`;
}

const files = [];
for (let i = 0; i < count; i++) {
  const path = `src/m${i}.ts`;
  const t0 = performance.now();
  const { status, symbols } = await compareFileWithFingerprints({
    path,
    change: 'mod',
    binary: false,
    before: source(i, 1),
    after: source(i, 2),
  });
  files.push({ path, status, after: source(i, 2), symbols, ms: performance.now() - t0 });
}
const compareMs = files.reduce((sum, file) => sum + file.ms, 0);
const input = { files: files.map(({ ms: _ms, ...file }) => file), tsconfig: null };

const times = [];
let graph;
for (let run = 0; run <= runs; run++) {
  const start = performance.now();
  graph = await buildCallGraph(input);
  times.push(performance.now() - start);
}
const [first, ...rest] = times;
rest.sort((a, b) => a - b);
const at = (p) => rest[Math.min(rest.length - 1, Math.ceil(p * rest.length) - 1)];
const edges = [...graph.edges.values()].reduce((sum, list) => sum + list.length, 0);
process.stdout.write(
  [
    `files: ${count}, symbols: ${files.reduce((sum, f) => sum + f.symbols.length, 0)}, edges: ${edges}, mode: ${graph.mode}`,
    `symbol comparison (already in a collect): ${compareMs.toFixed(0)} ms`,
    `graph, first build (loads ts-morph): ${first.toFixed(0)} ms`,
    `graph, later builds over ${runs} runs: median ${at(0.5).toFixed(0)} ms, p95 ${at(0.95).toFixed(0)} ms`,
    '',
  ].join('\n'),
);
