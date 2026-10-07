#!/usr/bin/env node
// Measures what the call graph and the execution path (ADR-034) add to a
// collect, on a synthetic change of N touched TS files (default 300) built in
// memory.
//
//   npm run build:node
//   node scripts/measure-graph.mjs [--files 300] [--runs 20] [--path-only]
//
// --path-only skips the graph section, so the path's first build is cold
// (it loads ts-morph itself, as the first snapshot of a worker does).
//
// Prints the time of the symbol comparison the report already pays for, the
// first graph build (it includes loading ts-morph, once per worker) and the
// median and p95 of the following builds; then the same for the whole path
// (step diffs and entry facts of every file, graph, entries, order, why).
// No repo, no disk: invented sources.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { compareFileWithFingerprints } = await import(pathToFileURL(join(dist, 'core', 'diff', 'status.js')).href);
const { buildCallGraph } = await import(pathToFileURL(join(dist, 'core', 'path', 'graph.js')).href);
const { preparePathFile } = await import(pathToFileURL(join(dist, 'core', 'path', 'prepare.js')).href);
const { buildExecutionPath } = await import(pathToFileURL(join(dist, 'core', 'path', 'order.js')).href);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const count = option('--files', 300);
const runs = option('--runs', 20);
const pathOnly = args.includes('--path-only');

/** One file: a class and three functions, calling into the next few files. */
function source(i, version) {
  const imports = [1, 2, 3].map((d) => (i + d) % count);
  const lines = imports.map((j) => `import { fn${j}a, Svc${j} } from './m${j}';`);
  lines.push('');
  // One entry point, so the BFS walks the whole change.
  if (i === 0) lines.push('export function main(): number {', `  return fn${imports[0]}a(${version});`, '}', '');
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
  const before = source(i, 1);
  const after = source(i, 2);
  const { status, symbols, ranges } = await compareFileWithFingerprints({ path, change: 'mod', binary: false, before, after });
  files.push({ path, status, before, after, symbols, ranges, ms: performance.now() - t0 });
}
const compareMs = files.reduce((sum, file) => sum + file.ms, 0);
const input = { files: files.map(({ path, status, after, symbols }) => ({ path, status, after, symbols })), tsconfig: null };

const times = [];
let graph;
for (let run = 0; run <= (pathOnly ? -1 : runs); run++) {
  const start = performance.now();
  graph = await buildCallGraph(input);
  times.push(performance.now() - start);
}
const summary = (list) => {
  const [head, ...tail] = list;
  tail.sort((a, b) => a - b);
  const at = (p) => tail[Math.min(tail.length - 1, Math.ceil(p * tail.length) - 1)];
  return { first: head, median: at(0.5), p95: at(0.95) };
};
const graphTimes = pathOnly ? null : summary(times);
const edges = pathOnly ? 0 : [...graph.edges.values()].reduce((sum, list) => sum + list.length, 0);

// The whole path as buildReport runs it: prepare every file (diffs, entry facts), then the path.
const pathTimes = [];
let path;
for (let run = 0; run <= runs; run++) {
  const start = performance.now();
  const prepared = [];
  for (const file of files) prepared.push(await preparePathFile(file));
  path = await buildExecutionPath({ files: prepared, tsconfig: null, packageJson: null });
  pathTimes.push(performance.now() - start);
}
const pathSummary = summary(pathTimes);
const sections = path.steps.reduce((counts, step) => ({ ...counts, [step.section]: (counts[step.section] ?? 0) + 1 }), {});
process.stdout.write(
  [
    `files: ${count}, symbols: ${files.reduce((sum, f) => sum + f.symbols.length, 0)}, edges: ${pathOnly ? 'not counted' : edges}, mode: ${path.mode}`,
    `symbol comparison (already in a collect): ${compareMs.toFixed(0)} ms`,
    ...(graphTimes === null
      ? []
      : [
          `graph, first build (loads ts-morph): ${graphTimes.first.toFixed(0)} ms`,
          `graph, later builds over ${runs} runs: median ${graphTimes.median.toFixed(0)} ms, p95 ${graphTimes.p95.toFixed(0)} ms`,
        ]),
    `path: ${path.steps.length} steps (${Object.entries(sections).map(([name, n]) => `${name} ${n}`).join(', ')})`,
    `path, first build (graph + entries + order + diffs): ${pathSummary.first.toFixed(0)} ms`,
    `path, later builds over ${runs} runs: median ${pathSummary.median.toFixed(0)} ms, p95 ${pathSummary.p95.toFixed(0)} ms`,
    '',
  ].join('\n'),
);
