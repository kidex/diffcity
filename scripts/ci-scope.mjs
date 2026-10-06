#!/usr/bin/env node
// Decides how much of the CI a change needs, so a core-only or docs-only batch
// does not pay for the 12 screens shards. Prints `key=value` lines that the
// workflow appends to $GITHUB_OUTPUT.
//
//   node scripts/ci-scope.mjs --event push --ref refs/heads/main --before <sha> --sha <sha>
//   node scripts/ci-scope.mjs --event pull_request --base <sha> --sha <sha>
//   node scripts/ci-scope.mjs --event workflow_dispatch --full true
//   printf 'src/core/a.ts\n' | node scripts/ci-scope.mjs --event push --stdin
//
// Scope, from the changed paths:
//   none  every path is documentation (`*.md`, `docs/`): nothing runs
//   core  only core-side paths changed: check and acceptance run, the screens
//         shards and the visual baselines do not
//   full  anything under src/ui, the screens specs, the UI fixtures, the build
//         and workflow files, and every path that is not classified (fail safe)
// Tags, `workflow_dispatch` with full=true, and a diff that cannot be computed
// (first push of a branch, a missing commit) run everything.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ORDER = ['none', 'core', 'full'];

const ZERO_SHA = /^0+$/;

/** Paths that run everything. Checked before the others, so `design/x.md` is full. */
const FULL = [
  /^src\/ui\//,
  /^test\/e2e\/screens\//,
  /^test\/fixtures\/ui\//,
  /^vite[^/]*\.ts$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.github\//,
  /^design\//,
];

/** Paths whose change the check and acceptance jobs cover. */
const CORE = [/^src\/(?:core|daemon|cli)\//, /^test\/(?:unit|integration|fixtures)\//];

/** Documentation: `*.md` anywhere, or anything under `docs/`. */
const DOCS = [/\.md$/, /^docs\//];

/** @param {string} path @returns {'none' | 'core' | 'full'} */
export function classifyPath(path) {
  const p = path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (FULL.some((re) => re.test(p))) return 'full';
  if (DOCS.some((re) => re.test(p))) return 'none';
  if (CORE.some((re) => re.test(p))) return 'core';
  return 'full';
}

/**
 * The widest scope of the paths. An empty list is `full`: nothing says it is
 * safe to skip.
 * @param {readonly string[]} paths @returns {'none' | 'core' | 'full'}
 */
export function classify(paths) {
  const real = paths.map((p) => p.trim()).filter((p) => p !== '');
  if (real.length === 0) return 'full';
  let widest = 0;
  for (const path of real) widest = Math.max(widest, ORDER.indexOf(classifyPath(path)));
  return /** @type {'none' | 'core' | 'full'} */ (ORDER[widest]);
}

/**
 * What runs. `paths` is null when the diff is unknown.
 * @param {{ event: string, ref?: string, full?: boolean, paths: readonly string[] | null }} input
 */
export function plan({ event, ref = '', full = false, paths }) {
  const tag = ref.startsWith('refs/tags/');
  const main = ref === 'refs/heads/main';
  /** @type {string} */
  let reason;
  /** @type {'none' | 'core' | 'full'} */
  let scope;
  if (tag) {
    scope = 'full';
    reason = 'tag: everything runs';
  } else if (event === 'workflow_dispatch' && full) {
    scope = 'full';
    reason = 'workflow_dispatch full: everything runs';
  } else if (paths === null) {
    scope = 'full';
    reason = 'no usable diff: everything runs';
  } else {
    scope = classify(paths);
    reason = `${String(paths.length)} changed path(s): ${scope}`;
  }
  const run = scope !== 'none';
  const nodes = !run ? [] : tag || (event === 'push' && main) ? [22, 24] : [22];
  return {
    scope,
    reason,
    check: run,
    node: nodes,
    acceptance: run,
    screens: scope === 'full',
    visual: scope === 'full',
  };
}

/** The `key=value` lines for $GITHUB_OUTPUT. @param {ReturnType<typeof plan>} p */
export function format(p) {
  return [
    `scope=${p.scope}`,
    `check=${String(p.check)}`,
    `node=${JSON.stringify(p.node)}`,
    `acceptance=${String(p.acceptance)}`,
    `screens=${String(p.screens)}`,
    `visual=${String(p.visual)}`,
    `reason=${p.reason}`,
  ].join('\n');
}

/** Changed paths of `from..to`, or null when git cannot tell. @param {string} from @param {string} to */
function gitPaths(from, to) {
  if (from === '' || to === '' || ZERO_SHA.test(from) || ZERO_SHA.test(to)) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${from}..${to}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((line) => line !== '');
  } catch {
    return null;
  }
}

/** @param {string[]} argv */
function parse(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  let stdin = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--stdin') stdin = true;
    else if (arg.startsWith('--')) values[arg.slice(2)] = argv[++i] ?? '';
  }
  return { values, stdin };
}

function main() {
  const { values, stdin } = parse(process.argv.slice(2));
  const event = values['event'] ?? 'push';
  const from = values['before'] ?? values['base'] ?? '';
  const to = values['sha'] ?? 'HEAD';
  const paths = stdin ? readFileSync(0, 'utf8').split('\n').filter((line) => line.trim() !== '') : gitPaths(from, to);
  console.log(format(plan({ event, ref: values['ref'] ?? '', full: values['full'] === 'true', paths })));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
