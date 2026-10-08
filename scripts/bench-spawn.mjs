#!/usr/bin/env node
// Process-spawn bench (DC-45). On macOS a process started by executing a
// script that carries the `com.apple.provenance` xattr (a globally installed
// `diffcity` bin written by a provenance-tracked process) spawns children
// slowly, and so does every process below it. This bench measures how long
// spawning `/usr/bin/true` takes in a daemon-like process started in each of
// the ways the CLI could start the daemon, so a fix can be checked on a real
// machine:
//
//   node scripts/bench-spawn.mjs [--runs 15] [--json] [--scenarios node,shim,...]
//
// Scenarios (each measured process spawns /usr/bin/true `--runs` times and
// reports the median):
// - node:          `node probe.mjs`, the daemon started by `node <cli.js>`;
// - shim:          the probe is the shim itself, executed directly;
// - shim-execpath: the shim re-executes process.execPath with the probe as argv;
// - shim-detached: the same, detached in its own session (what spawnDaemon did);
// - shim-open:     the shim launches the probe through LaunchServices
//                  (`open -g -n -a <node> --args ...`, macOS only).
//
// The shim is a shebang script written into a temporary directory by this
// process: it carries the xattr only when this process is provenance-tracked
// (`shimProvenance` in the output says whether it does). The numbers depend on
// the machine's load (syspolicyd in particular); `loadavg` is recorded with
// them.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const SCENARIOS = ['node', 'shim', 'shim-execpath', 'shim-detached', 'shim-open'];

/** How the measured process of each scenario was started. */
const LAUNCHED_BY = {
  node: 'node probe.mjs',
  shim: 'the shim, executed directly',
  'shim-execpath': 'shim -> process.execPath probe.mjs',
  'shim-detached': 'shim -> process.execPath probe.mjs, detached',
  'shim-open': 'shim -> open -g -n -a <node> --args probe.mjs',
};

const PROBE = `import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [out, runs] = [process.argv[2], Number(process.argv[3])];
const samples = [];
for (let i = 0; i < runs; i++) {
  const t0 = process.hrtime.bigint();
  spawnSync('/usr/bin/true');
  samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
writeFileSync(out, JSON.stringify(samples));
`;

/**
 * The shim, a `#!/usr/bin/env node` script like the installed bin (the bench
 * puts this node first on its PATH): runs the probe itself, or starts it the
 * way its argv says.
 */
const SHIM = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const probe = fileURLToPath(new URL('./probe.mjs', import.meta.url));
const [mode, out, runs] = process.argv.slice(2);
if (mode === 'shim') {
  // The probe reads its argv: hand it this process's, then run it here.
  process.argv.splice(2, process.argv.length, out, runs);
  await import(new URL('./probe.mjs', import.meta.url).href);
} else if (mode === 'shim-open') {
  spawn('/usr/bin/open', ['-g', '-n', '-a', process.execPath, '--args', probe, out, runs], { stdio: 'ignore' });
} else {
  const child = spawn(process.execPath, [probe, out, runs], { stdio: 'ignore', detached: mode === 'shim-detached' });
  child.unref();
}
`;

/** Median, min and max of `samples` (milliseconds), rounded to 0.01 ms. */
export function summarize(name, samples) {
  if (samples.length === 0) throw new Error(`${name}: no samples`);
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const round = (value) => Math.round(value * 100) / 100;
  return {
    name,
    launchedBy: LAUNCHED_BY[name] ?? name,
    runs: sorted.length,
    medianMs: round(median),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

/** True when `file` carries com.apple.provenance; null off macOS. */
function hasProvenance(file) {
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.provenance', file], { stdio: 'ignore' });
  return result.status === 0;
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) || readFileSync(file, 'utf8') === '') {
    if (Date.now() > deadline) throw new Error(`no result in ${file} within ${String(timeoutMs)} ms`);
    await sleep(20);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Runs one scenario and resolves with its samples. */
async function runScenario(dir, name, runs, timeoutMs) {
  const out = join(dir, `${name}.json`);
  const probe = join(dir, 'probe.mjs');
  if (name === 'node') {
    execFileSync(process.execPath, [probe, out, String(runs)]);
  } else {
    await new Promise((resolve, reject) => {
      const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
      const child = spawn(join(dir, 'shim.mjs'), [name, out, String(runs)], { stdio: 'ignore', env });
      child.once('error', reject);
      child.once('exit', resolve);
    });
  }
  return waitForFile(out, timeoutMs);
}

/**
 * Measures `scenarios` (default: all that run on this platform) and resolves
 * with the record the script prints.
 */
export async function runBench({ runs = 15, scenarios, timeoutMs = 120_000 } = {}) {
  const wanted = (scenarios ?? SCENARIOS).filter((name) => name !== 'shim-open' || process.platform === 'darwin');
  for (const name of wanted) if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario: ${name}`);
  const dir = mkdtempSync(join(tmpdir(), 'diffcity-bench-spawn-'));
  try {
    writeFileSync(join(dir, 'probe.mjs'), PROBE);
    writeFileSync(join(dir, 'shim.mjs'), SHIM);
    chmodSync(join(dir, 'shim.mjs'), 0o755);
    const results = [];
    for (const name of wanted) results.push(summarize(name, await runScenario(dir, name, runs, timeoutMs)));
    return {
      platform: process.platform,
      node: process.version,
      loadavg: loadavg().map((value) => Math.round(value * 100) / 100),
      runs,
      shimProvenance: hasProvenance(join(dir, 'shim.mjs')),
      scenarios: results,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The record as a plain-text table. */
export function formatTable(record) {
  const lines = [
    `platform ${record.platform}, node ${record.node}, load ${record.loadavg.join(' ')}, ${String(record.runs)} spawns each, shim provenance: ${String(record.shimProvenance)}`,
    'scenario        median ms   min ms     max ms     started as',
  ];
  for (const s of record.scenarios) {
    const cell = (value) => value.toFixed(2).padStart(9);
    lines.push(`${s.name.padEnd(15)} ${cell(s.medianMs)}  ${cell(s.minMs)}  ${cell(s.maxMs)}  ${s.launchedBy}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const option = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const runs = Number(option('--runs') ?? 15);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs takes a positive integer');
  const scenarios = option('--scenarios')?.split(',');
  const record = await runBench({ runs, scenarios });
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(record, null, 2)}\n` : formatTable(record));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`bench-spawn: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
