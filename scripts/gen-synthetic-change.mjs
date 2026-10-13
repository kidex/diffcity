#!/usr/bin/env node
// Builds an invented git repo with one large change, for measuring collection
// and import on it (DC-143).
//
//   node scripts/gen-synthetic-change.mjs <dir> [--files 300] [--name acme-cli]
//
// `<dir>` must not exist. The repo has <files> TS files on `main`, the first
// half under src/app/ and the rest under src/core/, each with a class and three
// functions that call into the next three files (the shape of
// scripts/measure-graph.mjs). The branch `feature/sweep` changes every file in
// one commit and stays checked out, so the repo's change is a Branch touching
// every file. git runs without the user's global or system config.
//
// The measurement of DC-143 (later repos collect in about the first one's
// time; the first import after a collection takes about as long as the next):
//
//   npm run build:node
//   for i in 1 2 3 4 5 6 7 8 9 10; do node scripts/gen-synthetic-change.mjs "$TMPDIR/acme/acme-cli-$i"; done
//   echo '[{"source":"claude","file":"src/app/m3.ts","line":3,"severity":"med","category":"correctness","title":"Off by one","message":"The total adds the version twice."}]' > "$TMPDIR/acme/findings.json"
//   node scripts/measure-collect.mjs "$TMPDIR"/acme/acme-cli-* --import "$TMPDIR/acme/findings.json"

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function usage(message) {
  if (message) process.stderr.write(`gen-synthetic-change: ${message}\n`);
  process.stderr.write('usage: node scripts/gen-synthetic-change.mjs <dir> [--files 300] [--name acme-cli]\n');
  process.exit(2);
}

const args = process.argv.slice(2);
let count = 300;
let name = 'acme-cli';
let target = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--files') {
    count = Number(args[++i]);
    if (!Number.isInteger(count) || count < 4) usage('--files needs an integer of at least 4');
  } else if (arg === '--name') {
    name = args[++i] ?? usage('--name needs a value');
  } else if (arg === '-h' || arg === '--help') {
    usage();
  } else if (arg.startsWith('-')) {
    usage(`unknown option ${arg}`);
  } else {
    target = resolve(arg);
  }
}
if (target === null) usage('give a directory');
if (existsSync(target)) usage('the directory already exists');

const half = Math.floor(count / 2);
const pathOf = (i) => `src/${i < half ? 'app' : 'core'}/m${String(i)}.ts`;
const importOf = (from, to) => {
  const a = dirname(pathOf(from));
  const b = dirname(pathOf(to));
  return a === b ? `./m${String(to)}` : `../${b.slice('src/'.length)}/m${String(to)}`;
};

/** One file: a class and three functions, calling into the next three files. */
function source(i, version) {
  const next = [1, 2, 3].map((d) => (i + d) % count);
  const lines = next.map((j) => `import { fn${j}a, Svc${j} } from '${importOf(i, j)}';`);
  lines.push('');
  if (i === 0) lines.push('export function main(): number {', `  return fn${next[0]}a(${version});`, '}', '');
  lines.push(`export class Svc${i} {`, '  run(x: number): number {', `    return new Svc${next[0]}().run(x) + ${version};`, '  }', '}');
  for (const suffix of ['a', 'b', 'c']) {
    lines.push('', `export function fn${i}${suffix}(x: number): number {`);
    lines.push(`  const total = ${next.map((j) => `fn${j}a(x)`).join(' + ')};`);
    lines.push(`  return total + ${version};`, '}');
  }
  return `${lines.join('\n')}\n`;
}

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Acme Dev',
  GIT_AUTHOR_EMAIL: 'dev@acme.invalid',
  GIT_COMMITTER_NAME: 'Acme Dev',
  GIT_COMMITTER_EMAIL: 'dev@acme.invalid',
};
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: target, env, stdio: ['ignore', 'ignore', 'inherit'] });

async function writeAll(version) {
  for (let i = 0; i < count; i++) {
    const file = join(target, pathOf(i));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source(i, version));
  }
}

await mkdir(target, { recursive: true });
git('init', '--quiet', '--initial-branch=main');
await writeFile(join(target, 'README.md'), `# ${name}\n`);
await writeAll(1);
git('add', '-A');
git('commit', '--quiet', '-m', 'initial sources');
git('checkout', '--quiet', '-b', 'feature/sweep');
await writeAll(2);
git('commit', '--quiet', '-am', 'sweep every module');
process.stdout.write(`${target}: ${String(count)} files on main, all changed on feature/sweep\n`);
