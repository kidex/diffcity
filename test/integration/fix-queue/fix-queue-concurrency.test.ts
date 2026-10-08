// The fix queue under real concurrency (DC-111, redesigned by DC-112): one
// process appends 50 items to the fix queue through the built
// src/core/fix-queue, while another process takes the queue over and over by
// renaming its directory away, as /diffcity-review does with
// `mv .diffcity/fix-queue .diffcity/fix-queue.taking`. Every item must end up
// in exactly one taken directory or in the final queue: none lost, none
// duplicated, and no append refused. The mover renames to a new name each
// time so every take is kept.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const FIX_QUEUE_DIST = fileURLToPath(new URL('../../../dist/core/fix-queue/index.js', import.meta.url));
const ITEMS = 50;
/**
 * Rounds per test: the window is a few microseconds wide, so one race rarely
 * hits it. Each test gets 300 s: the file runs in the timing project, alone,
 * where 100 rounds take about 7 s.
 */
const ROUNDS = 100;

const roots: string[] = [];
/** Children still running: a test that fails or times out must not leave a mover spinning on a core. */
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Runs a node ES module given as text; resolves with its exit code and stdout. */
function runNode(source: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Calls per item at most: an item refused with fix-queue-busy is tried again,
 * up to this many calls (each call already makes FIX_QUEUE_ATTEMPTS writes).
 * Against the tight-loop mover every one of 10,000 measured items landed on
 * its first call, so 3 leaves room for a loaded machine while a refusal that
 * keeps coming back still fails the test.
 */
const MAX_CALLS = 3;

/** Appends ITEMS items, calling again on fix-queue-busy up to MAX_CALLS; prints each outcome and its call count. */
const APPENDER = `
import { appendToFixQueue } from ${JSON.stringify(FIX_QUEUE_DIST)};
const [root, count] = process.argv.slice(1);
const outcomes = [];
const calls = [];
for (let n = 0; n < Number(count); n++) {
  const item = { key: 'f:' + n.toString(16).padStart(16, '0'), file: 'src/kettle/brew.ts', line: 7, severity: 'med',
    title: 'Invented finding ' + n, message: 'An invented finding.', queuedAt: '2026-10-08T09:00:00.000Z' };
  let result = appendToFixQueue(root, item);
  let tries = 1;
  while (!result.ok && result.code === 'fix-queue-busy' && tries < ${String(MAX_CALLS)}) { result = appendToFixQueue(root, item); tries++; }
  outcomes.push(result.ok ? (result.queued ? 'queued' : 'duplicate') : result.code);
  calls.push(tries);
}
process.stdout.write(JSON.stringify({ outcomes, calls }));
`;

/**
 * Renames the queue directory away to taken-<n> in a tight loop until the
 * stop file appears. It also stops when its temporary root is gone or after
 * 60 s, so a failed round never leaves it spinning.
 */
const MOVER = `
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const [root] = process.argv.slice(1);
const dir = join(root, '.diffcity');
const deadline = Date.now() + 60000;
let taken = 0;
while (!existsSync(join(root, 'stop')) && existsSync(dir) && Date.now() < deadline) {
  try { renameSync(join(dir, 'fix-queue'), join(dir, 'taken-' + taken)); taken++; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
process.stdout.write(String(taken));
`;

interface RaceOutcome {
  /** The appender's outcome per item: queued, duplicate or a refusal code. */
  outcomes: string[];
  /** appendToFixQueue calls per item (1 when the first call queued it). */
  calls: number[];
  /** Every key found in the taken directories and the final queue, sorted. */
  keys: string[];
  /** Temporary files left in the final queue directory. */
  temporaries: string[];
}

/** An item file: 32 hex digits and `.json`; anything else (a temporary file) is not an item. */
const ITEM_NAME = /^[0-9a-f]{32}\.json$/;

/** One race: the mover takes the queue in a loop while the appender appends ITEMS items. */
async function race(): Promise<RaceOutcome> {
  const root = await mkdtemp(join(tmpdir(), 'dc-fixq-conc-'));
  roots.push(root);
  await mkdir(join(root, '.diffcity'));
  const mover = runNode(MOVER, [root]);
  let appender;
  try {
    appender = await runNode(APPENDER, [root, String(ITEMS)]);
  } finally {
    await writeFile(join(root, 'stop'), '');
  }
  const moved = await mover;
  expect(appender).toMatchObject({ code: 0, stderr: '' });
  expect(moved).toMatchObject({ code: 0, stderr: '' });

  const keys: string[] = [];
  let temporaries: string[] = [];
  for (const queue of await readdir(join(root, '.diffcity'))) {
    const dir = join(root, '.diffcity', queue);
    const names = await readdir(dir);
    for (const name of names.filter((entry) => ITEM_NAME.test(entry))) {
      const item = JSON.parse(await readFile(join(dir, name), 'utf8')) as { key: string };
      keys.push(item.key);
    }
    if (queue === 'fix-queue') temporaries = names.filter((entry) => !ITEM_NAME.test(entry));
  }
  const { outcomes, calls } = JSON.parse(appender.stdout) as { outcomes: string[]; calls: number[] };
  return { outcomes, calls, keys: keys.sort(), temporaries };
}

const keyOf = (n: number): string => `f:${n.toString(16).padStart(16, '0')}`;

describe('fix-queue/concurrent-take (DC-111, DC-112)', () => {
  it('fix-queue/concurrent-take: every queued item ends up in exactly one taken directory or the final queue, none lost, none duplicated', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { outcomes, keys, temporaries } = await race();
      const queued = outcomes.flatMap((outcome, n) => (outcome === 'queued' ? [keyOf(n)] : []));
      expect({ round, keys }).toEqual({ round, keys: queued });
      expect(temporaries).toEqual([]);
    }
  }, 300_000);

  it('fix-queue/concurrent-take-no-refusal: a queue taken during an append is written again; no item needs more than MAX_CALLS calls', async () => {
    let extraCalls = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const { outcomes, calls } = await race();
      expect({ round, outcomes }).toEqual({ round, outcomes: Array.from({ length: ITEMS }, () => 'queued') });
      // The appender gives up after MAX_CALLS calls, so a queued item took at most that many.
      expect(Math.max(...calls)).toBeLessThanOrEqual(MAX_CALLS);
      extraCalls += calls.reduce((sum, count) => sum + count - 1, 0);
    }
    // A busy refusal is rare: well under one extra call per round on average.
    expect(extraCalls).toBeLessThan(ROUNDS);
  }, 300_000);
});
