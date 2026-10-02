#!/usr/bin/env node
// Measures collection on real repos for the phase report (SPEC.md section 9).
//
//   npm run build:node
//   node scripts/measure-collect.mjs <repo> [<repo> ...] [--timeout <seconds>]
//
// Starts a daemon from dist/ in a fresh temporary DIFFCITY_HOME (the real
// ~/.config/diffcity is never touched; no repo is trusted, so no repo config
// runs), then tracks the repos one at a time. For each repo it prints:
// - the time from the `track` request to its answer;
// - the time from the `track` request to the last `snapshot` SSE event of the
//   collection, and to the collection's `done` event;
// - the number of live changes and of snapshots, and the size in bytes of the
//   snapshots (the Report JSON served by /api/changes/:id/report).
// Repos are printed by index only, never by name or path, so the output can go
// into the phase report as it is. gh, git and HOME are the user's own.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const { homePaths } = await import(pathToFileURL(join(dist, 'core', 'home.js')).href);
const { sendRequest } = await import(pathToFileURL(join(dist, 'daemon', 'client.js')).href);

function usage(message) {
  if (message) process.stderr.write(`measure-collect: ${message}\n`);
  process.stderr.write('usage: node scripts/measure-collect.mjs <repo> [<repo> ...] [--timeout <seconds>]\n');
  process.exit(2);
}

const args = process.argv.slice(2);
let timeoutMs = 300_000;
const repos = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--timeout') {
    const seconds = Number(args[++i]);
    if (!Number.isFinite(seconds) || seconds <= 0) usage('--timeout needs a number of seconds');
    timeoutMs = seconds * 1000;
  } else if (arg === '-h' || arg === '--help') {
    usage();
  } else if (arg.startsWith('-')) {
    usage(`unknown option ${arg}`);
  } else {
    repos.push(resolve(arg));
  }
}
if (repos.length === 0) usage('give at least one repo');

/** Reads GET /api/events and calls `onEvent(name, data, at)` for each event, `at` from performance.now(). */
async function listen(port, onEvent) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/events`, { signal: controller.signal });
  if (response.body === null) throw new Error('SSE response without a body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const at = performance.now();
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name !== undefined && data !== undefined) onEvent(name, JSON.parse(data), at);
          end = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted at the end.
    }
  })();
  return () => {
    controller.abort();
  };
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  if (!response.ok) throw new Error(`GET ${path}: ${String(response.status)}`);
  return response.json();
}

const ms = (value) => `${value.toFixed(0)} ms`;

const home = await mkdtemp(join(tmpdir(), 'dc-measure-'));
const paths = homePaths(join(home, 'home'));
const env = { ...process.env, DIFFCITY_HOME: paths.home };
let daemonStderr = '';
const daemon = spawn(process.execPath, [join(dist, 'cli', 'index.js'), 'up', '--foreground', '--no-open', '--port', '0'], {
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
daemon.stderr.setEncoding('utf8').on('data', (chunk) => (daemonStderr += chunk));

let exitCode = 0;
let stopListening = () => undefined;
try {
  const startDeadline = Date.now() + 20_000;
  let info = null;
  while (info === null) {
    info = await readFile(paths.daemonJson, 'utf8').then((text) => JSON.parse(text), () => null);
    if (daemon.exitCode !== null) throw new Error(`the daemon exited with ${String(daemon.exitCode)}`);
    if (Date.now() > startDeadline) throw new Error('the daemon did not start within 20 s');
    if (info === null) await sleep(25);
  }

  // One entry per repo id, created by whichever comes first: an event or the
  // track answer. Collection starts right after track answers, so a fast
  // `collect done` can arrive before the answer is processed; creating the
  // entry from the event keeps it instead of dropping it.
  const pending = new Map();
  const entryFor = (repoId) => {
    let entry = pending.get(repoId);
    if (entry === undefined) {
      const created = { lastSnapshot: null, snapshots: 0, done: null, finished: null };
      created.finished = new Promise((resolveDone) => {
        created.done = resolveDone;
      });
      pending.set(repoId, created);
      entry = created;
    }
    return entry;
  };
  stopListening = await listen(info.port, (name, data, at) => {
    if (typeof data.repoId !== 'number') return;
    const entry = entryFor(data.repoId);
    if (name === 'snapshot') {
      entry.lastSnapshot = at;
      entry.snapshots += 1;
    } else if (name === 'collect' && (data.state === 'done' || data.state === 'error')) {
      entry.done?.({ at, state: data.state });
    }
  });

  process.stdout.write(`measure-collect: ${String(repos.length)} repo(s), one at a time\n`);
  for (const [index, dir] of repos.entries()) {
    const label = `repo ${String(index + 1)}`;
    const t0 = performance.now();
    let response;
    try {
      response = await sendRequest(info.socket, { v: 1, type: 'track', dir, agent: false, at: new Date().toISOString() });
    } catch {
      process.stdout.write(`${label}: the track request failed\n`);
      exitCode = 1;
      continue;
    }
    const answered = performance.now() - t0;
    if (!response.ok) {
      // The message can name the path: not printed.
      process.stdout.write(`${label}: track refused the directory\n`);
      exitCode = 1;
      continue;
    }
    const repoId = response.repo.id;
    // Events of a collection already running for this repo would arrive before
    // the one this track asked for; a repo is tracked once, so none is expected.
    const entry = entryFor(repoId);
    const outcome = await Promise.race([entry.finished, sleep(timeoutMs).then(() => null)]);
    pending.delete(repoId);
    if (outcome === null) {
      process.stdout.write(`${label}: no collect done within ${String(timeoutMs / 1000)} s\n`);
      exitCode = 1;
      continue;
    }
    if (outcome.state === 'error') {
      process.stdout.write(`${label}: collect error after ${ms(outcome.at - t0)}\n`);
      exitCode = 1;
      continue;
    }

    const detail = await getJson(info.port, `/api/repos/${String(repoId)}`);
    const sizes = [];
    for (const change of detail.changes) {
      if (change.stats === null) continue;
      const reply = await fetch(`http://127.0.0.1:${String(info.port)}/api/changes/${String(change.id)}/report`);
      if (reply.ok) sizes.push((await reply.arrayBuffer()).byteLength);
    }
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const largest = sizes.length === 0 ? 0 : Math.max(...sizes);
    const lastSnapshot = entry.lastSnapshot === null ? 'no snapshot event' : ms(entry.lastSnapshot - t0);
    process.stdout.write(
      `${label}: track answered in ${ms(answered)}; last snapshot at ${lastSnapshot}; collect done at ${ms(outcome.at - t0)}; ` +
        `${String(detail.changes.length)} changes, ${String(sizes.length)} snapshots, ${String(total)} bytes total, largest ${String(largest)} bytes\n`,
    );
  }
} catch (error) {
  process.stderr.write(`measure-collect: ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  stopListening();
  const info = await readFile(paths.daemonJson, 'utf8').then((text) => JSON.parse(text), () => null);
  if (info !== null) await sendRequest(info.socket, { v: 1, type: 'shutdown' }, { timeoutMs: 2000 }).catch(() => undefined);
  const exited = daemon.exitCode !== null ? Promise.resolve() : new Promise((resolveExit) => daemon.once('exit', resolveExit));
  if ((await Promise.race([exited.then(() => 'exited'), sleep(5000).then(() => 'timeout')])) === 'timeout') daemon.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
  if (exitCode !== 0 && daemonStderr !== '' && process.env['MEASURE_COLLECT_DEBUG'] === '1') {
    // Opt-in: the daemon log names repos and paths.
    process.stderr.write(daemonStderr);
  }
}
process.exit(exitCode);
