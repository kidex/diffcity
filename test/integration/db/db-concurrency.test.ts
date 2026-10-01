// The daemon is the single writer (ADR-018), but other connections read the
// same file: reader processes opening it through openDb (pragmas plus the
// migrate transaction), plain readonly connections, and a second connection in
// the daemon's own process. WAL plus busy_timeout 5000 must give none of them
// SQLITE_BUSY while the daemon writes in a realistic loop. A connection that
// holds the write lock for a moment (openDb's migrate transaction takes it on
// every open) must make the daemon's writes wait, not fail.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { T0, addRepo, branchFields, daysAfter, sha, snapshotInput, tempDb, type TempDb, rawConnection } from '../../unit/db/db-helpers.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const distIndex = pathToFileURL(`${repoRoot}dist/core/db/index.js`).href;
const readerScript = fileURLToPath(new URL('../../fixtures/db/reader-process.mjs', import.meta.url));

interface ReaderResult {
  reads: number;
  errors: { code: string | null; message: string }[];
  opened: boolean;
}

interface Reader {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  result: Promise<ReaderResult>;
}

function startReader(path: string, mode: 'reader' | 'raw-reader' | 'lock-holder', arg: number): Reader {
  const child = spawn(process.execPath, [readerScript, distIndex, path, mode, String(arg)], {
    env: process.env,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const result = new Promise<ReaderResult>((resolve, reject) => {
    let last = '';
    lines.on('line', (line) => {
      if (line === 'ready') markReady();
      else last = line;
    });
    child.on('close', (code) => {
      if (code !== 0 || last === '') reject(new Error(`reader exited ${String(code)}: ${stderr}`));
      else resolve(JSON.parse(last) as ReaderResult);
    });
  });
  return { child, ready, result };
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let temp: TempDb | undefined;
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  temp?.cleanup();
  temp = undefined;
});

/** One collection round as the daemon would write it: a plan, a snapshot of `reportBytes`, a collect event. */
function writeRound(db: Db, repoId: number, round: number, reportBytes: number): void {
  const now = daysAfter(T0, round / 1000);
  db.transaction(() => {
    const live = db.changes.listLive(repoId);
    const target = live[round % Math.max(live.length, 1)];
    const plan =
      round % 5 === 0 || target === undefined
        ? { create: [branchFields(`feature-${String(round)}`, { lastEventAt: now })], update: [], archive: [] }
        : round % 7 === 0
          ? { create: [], update: [], archive: [{ id: target.id, reason: 'deleted' as const }] }
          : { create: [], update: [{ id: target.id, head: sha(), lastEventAt: now }], archive: [] };
    const applied = db.changes.applyPlan(repoId, plan, now);
    const change = applied.created[0] ?? applied.updated[0];
    if (change !== undefined) {
      const report = JSON.stringify({ meta: { round }, pad: 'x'.repeat(reportBytes) });
      const put = db.snapshots.put(
        snapshotInput(change.id, change.head, { report, contentHash: `hash-${String(round)}`, computedAt: now }),
      );
      if (put !== 'unchanged') db.events.add({ repoId, changeId: change.id, type: 'collect', at: now, payload: { round } });
    }
  });
  if (round % 50 === 0) {
    db.events.pruneCollect(now);
    db.purgeArchived(now);
  }
}

describe('db concurrency (ADR-018: WAL + busy_timeout)', () => {
  it('reader processes and a second connection never see SQLITE_BUSY while the daemon writes', async () => {
    temp = tempDb();
    const { db, path } = temp;
    const repo = addRepo(db);

    const readers = [
      startReader(path, 'reader', repo.id),
      startReader(path, 'reader', repo.id),
      startReader(path, 'raw-reader', repo.id),
    ];
    children.push(...readers.map((reader) => reader.child));
    await Promise.all(readers.map((reader) => reader.ready));

    // A second connection in the daemon's own process, as the HTTP API might hold.
    const sameProcess = rawConnection(path, { readOnly: true });
    const sameProcessErrors: unknown[] = [];
    let sameProcessReads = 0;

    const writerErrors: unknown[] = [];
    const rounds = 400;
    for (let round = 1; round <= rounds; round += 1) {
      try {
        writeRound(db, repo.id, round, 64 * 1024);
      } catch (error) {
        writerErrors.push(error);
      }
      try {
        sameProcess.prepare('SELECT count(*) AS n FROM snapshots').get();
        sameProcessReads += 1;
      } catch (error) {
        sameProcessErrors.push(error);
      }
      await yieldToLoop();
    }
    sameProcess.close();

    for (const reader of readers) reader.child.stdin.end();
    const results = await Promise.all(readers.map((reader) => reader.result));

    expect(writerErrors).toEqual([]);
    expect(sameProcessErrors).toEqual([]);
    expect(sameProcessReads).toBe(rounds);
    for (const result of results) {
      expect(result.errors).toEqual([]);
      expect(result.opened).toBe(true);
      expect(result.reads).toBeGreaterThan(0);
    }
    // The writes landed: snapshots exist and the database is consistent.
    const check = rawConnection(path, { readOnly: true });
    try {
      expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(check.pragma('foreign_key_check')).toEqual([]);
    } finally {
      check.close();
    }
  }, 120_000);

  it('a reader holding a long read transaction does not block the writer, and keeps its snapshot', async () => {
    temp = tempDb();
    const { db, path } = temp;
    const repo = addRepo(db);
    writeRound(db, repo.id, 5, 1024);

    const reader = rawConnection(path, { readOnly: true });
    const count = reader.prepare<[], { n: number }>('SELECT count(*) AS n FROM snapshots');
    reader.execScript('BEGIN');
    const before = count.get()?.n;

    const started = Date.now();
    for (let round = 10; round < 60; round += 5) writeRound(db, repo.id, round, 1024);
    const elapsed = Date.now() - started;

    // Still inside the read transaction: the old snapshot.
    expect(count.get()?.n).toBe(before);
    reader.execScript('COMMIT');
    expect(count.get()?.n).toBeGreaterThan(before ?? 0);
    reader.close();
    // The writer never waited on the reader's lock (busy_timeout is 5 s).
    expect(elapsed).toBeLessThan(2000);
    await yieldToLoop();
  });

  // Another connection holds the write lock for HOLD_MS, as openDb's migrate
  // transaction (BEGIN IMMEDIATE) does on every open. busy_timeout is 5000, so
  // each daemon write must wait for the lock and succeed. A deferred
  // transaction that reads before it writes gets SQLITE_BUSY at once instead:
  // SQLite does not call the busy handler when a read transaction upgrades.
  const HOLD_MS = 300;
  const writes: [string, (db: Db, repoId: number) => unknown][] = [
    ['events.add (single statement)', (db, repoId) => db.events.add({ repoId, changeId: null, type: 'agent', at: T0, payload: null })],
    ['snapshots.put', (db, repoId) => {
      const change = db.changes.listLive(repoId)[0];
      if (change === undefined) throw new Error('no change');
      return db.snapshots.put(snapshotInput(change.id, sha(), { computedAt: daysAfter(T0, 1) }));
    }],
    ['changes.applyPlan (an update, as every reconcile has)', (db, repoId) => {
      const change = db.changes.listLive(repoId)[0];
      if (change === undefined) throw new Error('no change');
      return db.changes.applyPlan(repoId, { create: [], update: [{ id: change.id, head: sha() }], archive: [] }, daysAfter(T0, 1));
    }],
    ['repos.upsert', (db) =>
      db.repos.upsert({ path: '/work/second-shop', gitCommonDir: '/work/second-shop/.git', name: 'second-shop', active: true, seenAt: T0 })],
  ];

  it.each(writes)('%s waits for a write lock held briefly by another process instead of failing with SQLITE_BUSY', async (_name, write) => {
    temp = tempDb();
    const { db, path } = temp;
    const repo = addRepo(db);
    writeRound(db, repo.id, 5, 1024);

    const holder = startReader(path, 'lock-holder', HOLD_MS);
    children.push(holder.child);
    await holder.ready;

    const started = Date.now();
    let error: unknown = null;
    try {
      write(db, repo.id);
    } catch (caught) {
      error = caught;
    }
    const waited = Date.now() - started;
    const held = await holder.result;

    expect(held.errors).toEqual([]);
    expect(error).toBeNull();
    // It waited for the holder to commit rather than returning at once.
    expect(waited).toBeGreaterThanOrEqual(HOLD_MS / 2);
  }, 30_000);
});
