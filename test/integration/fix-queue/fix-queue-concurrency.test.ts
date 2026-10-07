// DC-109 under real concurrency: one process appends 50 items to the fix queue
// through the built src/core/fix-queue, while another process takes the queue
// over and over by renaming it away, as /diffcity-review does with
// `mv .diffcity/fix-queue.json .diffcity/fix-queue.taking.json`. Every item
// must end up in exactly one taken file or in the final queue: none lost, none
// duplicated. The mover renames to a new name each time so every take is kept.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const FIX_QUEUE_DIST = fileURLToPath(new URL('../../../dist/core/fix-queue/index.js', import.meta.url));
const ITEMS = 50;
/** Rounds per test: the window is a few microseconds wide, so one race rarely hits it. */
const ROUNDS = 100;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Runs a node ES module given as text; resolves with its exit code and stdout. */
function runNode(source: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** Appends ITEMS items, retrying an item refused with fix-queue-busy; prints the outcome of each. */
const APPENDER = `
import { appendToFixQueue } from ${JSON.stringify(FIX_QUEUE_DIST)};
const [root, count] = process.argv.slice(1);
const outcomes = [];
for (let n = 0; n < Number(count); n++) {
  const item = { key: 'f:' + n.toString(16).padStart(16, '0'), file: 'src/kettle/brew.ts', line: 7, severity: 'med',
    title: 'Invented finding ' + n, message: 'An invented finding.', queuedAt: '2026-10-08T09:00:00.000Z' };
  let result = appendToFixQueue(root, item);
  let tries = 1;
  while (!result.ok && result.code === 'fix-queue-busy' && tries < 100) { result = appendToFixQueue(root, item); tries++; }
  outcomes.push(result.ok ? (result.queued ? 'queued' : 'duplicate') : result.code);
}
process.stdout.write(JSON.stringify(outcomes));
`;

/** Renames the queue away to taken-<n>.json in a tight loop until the stop file appears. */
const MOVER = `
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const [root] = process.argv.slice(1);
const dir = join(root, '.diffcity');
let taken = 0;
while (!existsSync(join(root, 'stop'))) {
  try { renameSync(join(dir, 'fix-queue.json'), join(dir, 'taken-' + taken + '.json')); taken++; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
process.stdout.write(String(taken));
`;

interface RaceOutcome {
  /** The appender's outcome per item: queued, duplicate or a refusal code. */
  outcomes: string[];
  /** Every key found in the taken files and the final queue, sorted. */
  keys: string[];
  temporaries: string[];
}

/** One race: the mover takes the queue in a loop while the appender appends ITEMS items. */
async function race(): Promise<RaceOutcome> {
  const root = await mkdtemp(join(tmpdir(), 'dc-fixq-conc-'));
  roots.push(root);
  await mkdir(join(root, '.diffcity'));
  const mover = runNode(MOVER, [root]);
  const appender = await runNode(APPENDER, [root, String(ITEMS)]);
  await writeFile(join(root, 'stop'), '');
  const moved = await mover;
  expect(appender).toMatchObject({ code: 0, stderr: '' });
  expect(moved).toMatchObject({ code: 0, stderr: '' });

  const entries = await readdir(join(root, '.diffcity'));
  const keys: string[] = [];
  for (const name of entries.filter((entry) => entry.endsWith('.json'))) {
    const queue = JSON.parse(await readFile(join(root, '.diffcity', name), 'utf8')) as { version: number; items: { key: string }[] };
    expect(queue.version).toBe(1);
    keys.push(...queue.items.map((item) => item.key));
  }
  return { outcomes: JSON.parse(appender.stdout) as string[], keys: keys.sort(), temporaries: entries.filter((entry) => entry.endsWith('.tmp')) };
}

const keyOf = (n: number): string => `f:${n.toString(16).padStart(16, '0')}`;

describe('fix-queue/concurrent-take (DC-109)', () => {
  it('fix-queue/concurrent-take: every queued item ends up in exactly one taken file or the final queue, none lost, none duplicated', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { outcomes, keys, temporaries } = await race();
      const queued = outcomes.flatMap((outcome, n) => (outcome === 'queued' ? [keyOf(n)] : []));
      expect({ round, keys }).toEqual({ round, keys: queued });
      expect(temporaries).toEqual([]);
    }
  }, 120_000);

  it('fix-queue/concurrent-take-no-refusal: a queue taken while it is read is read again, never refused as unsafe', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { outcomes } = await race();
      expect({ round, outcomes }).toEqual({ round, outcomes: Array.from({ length: ITEMS }, () => 'queued') });
    }
  }, 120_000);
});
