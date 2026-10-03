// The snapshots store: one row per (change, head), identical hash skipped, the latest by computedAt (ADR-018, SPEC.md 4.2).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import type { ChangeRecord } from '../../../src/core/model/types.js';
import { openDb } from '../../../src/core/db/index.js';
import { T0, tempDbPath, addRepo, branchFields, daysAfter, sampleSummary, sha, snapshotInput, tempDb, type TempDb, rawConnection } from './db-helpers.js';

let temp: TempDb;
let db: Db;
let change: ChangeRecord;

beforeEach(() => {
  temp = tempDb();
  db = temp.db;
  const repo = addRepo(db);
  const [created] = db.changes.applyPlan(repo.id, { create: [branchFields('cart-totals')], update: [], archive: [] }, T0)
    .created;
  if (created === undefined) throw new Error('not created');
  change = created;
});
afterEach(() => {
  temp.cleanup();
});

function rowCount(): number {
  const raw = rawConnection(temp.path, { readOnly: true });
  try {
    return (raw.prepare<[], { n: number }>('SELECT count(*) AS n FROM snapshots').get()?.n) ?? -1;
  } finally {
    raw.close();
  }
}

describe('snapshots', () => {
  it('db/snapshot-one-per-head: a second put on the same head with another hash replaces the row', () => {
    expect(db.snapshots.put(snapshotInput(change.id, change.head))).toBe('created');
    const first = db.snapshots.latest(change.id);

    const second = snapshotInput(change.id, change.head, {
      dirty: true,
      contentHash: 'hash-2',
      report: '{"meta":{"repo":"sample-shop","v":2}}',
      summary: sampleSummary({ touchedFiles: 5 }),
      touched: ['src/orders/cart.ts'],
      computedAt: daysAfter(T0, 1),
    });
    expect(db.snapshots.put(second)).toBe('replaced');

    expect(rowCount()).toBe(1);
    expect(db.snapshots.latest(change.id)).toEqual({ ...second, id: first?.id });
  });

  it('db/snapshot-one-per-head: a new head adds a row and keeps the old one', () => {
    expect(db.snapshots.put(snapshotInput(change.id, change.head))).toBe('created');
    expect(db.snapshots.put(snapshotInput(change.id, sha(), { computedAt: daysAfter(T0, 1) }))).toBe('created');
    expect(rowCount()).toBe(2);
  });

  it('db/snapshot-same-hash-skipped: an identical hash is unchanged and writes nothing', () => {
    db.snapshots.put(snapshotInput(change.id, change.head));
    const before = db.snapshots.latest(change.id);

    const result = db.snapshots.put(
      snapshotInput(change.id, change.head, { computedAt: daysAfter(T0, 1), report: '{"meta":{"generatedAt":"later"}}' }),
    );

    expect(result).toBe('unchanged');
    expect(db.snapshots.latest(change.id)).toEqual(before);
    expect(rowCount()).toBe(1);
  });

  it('db/latest-snapshot: back on an older head with identical content (A -> B -> A), A is the latest again', () => {
    const headA = change.head;
    const headB = sha();
    expect(db.snapshots.put(snapshotInput(change.id, headA, { contentHash: 'hash-a', computedAt: T0 }))).toBe('created');
    expect(
      db.snapshots.put(snapshotInput(change.id, headB, { contentHash: 'hash-b', computedAt: daysAfter(T0, 1) })),
    ).toBe('created');
    const before = db.snapshots.latest(change.id);
    expect(before?.head).toBe(headB);

    const back = daysAfter(T0, 2);
    expect(db.snapshots.put(snapshotInput(change.id, headA, { contentHash: 'hash-a', computedAt: back }))).toBe('replaced');

    expect(db.snapshots.latest(change.id)).toMatchObject({ head: headA, contentHash: 'hash-a', computedAt: back });
    expect(rowCount()).toBe(2);
    // Now A is the latest, so the same put again writes nothing.
    expect(
      db.snapshots.put(snapshotInput(change.id, headA, { contentHash: 'hash-a', computedAt: daysAfter(T0, 3) })),
    ).toBe('unchanged');
    expect(db.snapshots.latest(change.id)?.computedAt).toBe(back);
  });

  it('db/latest-snapshot: the latest is the greatest computedAt, whatever the write order', () => {
    const newest = snapshotInput(change.id, sha(), { computedAt: daysAfter(T0, 2), report: '{"n":"newest"}' });
    db.snapshots.put(newest);
    db.snapshots.put(snapshotInput(change.id, sha(), { computedAt: daysAfter(T0, 1), report: '{"n":"middle"}' }));
    db.snapshots.put(snapshotInput(change.id, change.head, { computedAt: T0, report: '{"n":"oldest"}' }));

    expect(db.snapshots.latest(change.id)).toMatchObject({ head: newest.head, computedAt: newest.computedAt });
    expect(db.snapshots.latestReport(change.id)).toBe('{"n":"newest"}');
  });

  it('db/latest-snapshot: latestReport returns the stored text verbatim', () => {
    const report = '{\n  "meta": { "repo": "sample-shop" },\n  "findings": []\n}';
    db.snapshots.put(snapshotInput(change.id, change.head, { report }));
    expect(db.snapshots.latestReport(change.id)).toBe(report);
  });

  it('db/latest-snapshot: null while the change has no snapshot', () => {
    expect(db.snapshots.latest(change.id)).toBeNull();
    expect(db.snapshots.latestReport(change.id)).toBeNull();
  });

  it('decodes dirty, summary and touched', () => {
    db.snapshots.put(snapshotInput(change.id, change.head, { dirty: true }));
    expect(db.snapshots.latest(change.id)).toMatchObject({
      dirty: true,
      summary: sampleSummary(),
      touched: ['src/auth/session.ts', 'src/orders/cart.ts'],
    });
  });

  it('refuses a report that is not JSON and a snapshot for an unknown change', () => {
    expect(() => db.snapshots.put(snapshotInput(change.id, change.head, { report: '{not json' }))).toThrow(/not valid JSON/);
    expect(() => db.snapshots.put(snapshotInput(9999, change.head))).toThrow(/FOREIGN KEY constraint failed/);
    expect(rowCount()).toBe(0);
  });
});

describe('snapshots: refreshed', () => {
  const fp = (after: string): string => JSON.stringify({ files: { 'f-a': { before: 'b', after } }, symbols: {} });

  it('snapshots/put-refreshed-same-report-new-fingerprints: same Report hash, other fingerprints: the latest row takes them in place', () => {
    const first = snapshotInput(change.id, change.head, { contentHash: 'h1', fingerprints: fp('A'), mergeBase: 'a'.repeat(40) });
    expect(db.snapshots.put(first)).toBe('created');
    const before = db.snapshots.latest(change.id);

    const again = { ...first, fingerprints: fp('B'), mergeBase: 'b'.repeat(40), computedAt: daysAfter(T0, 1), report: '{"meta":{"ignored":true}}' };
    expect(db.snapshots.put(again)).toBe('refreshed');

    expect(rowCount()).toBe(1);
    const after = db.snapshots.latest(change.id);
    expect(after).toEqual({ ...before, fingerprints: fp('B'), mergeBase: 'b'.repeat(40) });
    expect(after?.contentHash).toBe('h1');
    expect(after?.report).toBe(before?.report);
    expect(after?.computedAt).toBe(before?.computedAt);
    // Now identical to the stored fingerprints: nothing more to do.
    expect(db.snapshots.put(again)).toBe('unchanged');
  });

  it('snapshots/put-unchanged-same-report-same-fingerprints: identical hash and fingerprints stay unchanged, whatever the key order', () => {
    const input = snapshotInput(change.id, change.head, {
      contentHash: 'h1',
      fingerprints: '{"files":{"a":{"before":"1","after":"2"},"b":{"before":null,"after":"3"}},"symbols":{"s":"x","t":"y"}}',
    });
    db.snapshots.put(input);
    const reordered = '{"symbols":{"t":"y","s":"x"},"files":{"b":{"after":"3","before":null},"a":{"after":"2","before":"1"}}}';
    expect(db.snapshots.put({ ...input, fingerprints: reordered, computedAt: daysAfter(T0, 1) })).toBe('unchanged');
    expect(db.snapshots.latest(change.id)?.computedAt).toBe(T0);
  });

  it('latestMeta reads the id, head, dirty flag, merge-base and fingerprints of the latest snapshot, and nothing for none', () => {
    expect(db.snapshots.latestMeta(change.id)).toBeNull();
    db.snapshots.put(snapshotInput(change.id, change.head, { contentHash: 'h1', fingerprints: fp('A'), mergeBase: 'e'.repeat(40), dirty: true }));
    const latest = db.snapshots.latest(change.id);
    expect(db.snapshots.latestMeta(change.id)).toEqual({
      id: latest?.id,
      head: change.head,
      dirty: true,
      mergeBase: 'e'.repeat(40),
      fingerprints: fp('A'),
    });
  });

  it('a row written before schema v2 (no fingerprints) is refreshed by the first put with fingerprints', () => {
    const old = snapshotInput(change.id, change.head, { contentHash: 'h1', fingerprints: null, mergeBase: null });
    db.snapshots.put(old);
    expect(db.snapshots.put({ ...old, fingerprints: fp('A'), mergeBase: 'c'.repeat(40) })).toBe('refreshed');
    expect(db.snapshots.latestFingerprints(change.id)).toBe(fp('A'));
  });

  it('snapshots/put-mergebase-only-stored-unchanged: a merge-base-only difference is stored quietly and stays unchanged', () => {
    const input = snapshotInput(change.id, change.head, { contentHash: 'h1', fingerprints: fp('A'), mergeBase: null });
    db.snapshots.put(input);
    expect(db.snapshots.put({ ...input, mergeBase: 'd'.repeat(40) })).toBe('unchanged');
    expect(db.snapshots.latest(change.id)?.mergeBase).toBe('d'.repeat(40));
  });

  it('snapshots/put-a-b-a-writes-fingerprints: a return to an older head with the same Report takes the fresh fingerprints and merge-base', () => {
    const a = snapshotInput(change.id, change.head, { contentHash: 'h1', fingerprints: fp('A') });
    db.snapshots.put(a);
    db.snapshots.put(snapshotInput(change.id, sha(), { contentHash: 'h2', computedAt: daysAfter(T0, 1) }));
    expect(db.snapshots.put({ ...a, fingerprints: fp('Z'), mergeBase: 'e'.repeat(40), computedAt: daysAfter(T0, 2) })).toBe('replaced');
    expect(db.snapshots.latest(change.id)).toMatchObject({ fingerprints: fp('Z'), mergeBase: 'e'.repeat(40) });
  });

  it('snapshots/put-null-fingerprints-keeps-stored: a put without fingerprints keeps the stored ones and follows the hash rule', () => {
    const input = snapshotInput(change.id, change.head, { contentHash: 'h1', fingerprints: fp('A'), mergeBase: 'a'.repeat(40) });
    db.snapshots.put(input);
    expect(db.snapshots.put({ ...input, fingerprints: null, mergeBase: null })).toBe('unchanged');
    expect(db.snapshots.latest(change.id)).toMatchObject({ fingerprints: fp('A'), mergeBase: 'a'.repeat(40) });
    // Back from another head with the same Report: also keeps them.
    db.snapshots.put(snapshotInput(change.id, sha(), { contentHash: 'h2', computedAt: daysAfter(T0, 1) }));
    expect(db.snapshots.put({ ...input, fingerprints: null, mergeBase: null, computedAt: daysAfter(T0, 2) })).toBe('replaced');
    expect(db.snapshots.latest(change.id)).toMatchObject({ fingerprints: fp('A'), mergeBase: 'a'.repeat(40) });
  });

  it('snapshots/corrupt-stored-fingerprints-refreshed: an unparsable stored value is replaced, with a warning that does not hold it', () => {
    const { path, remove } = tempDbPath();
    const warnings: string[] = [];
    const own = openDb(path, { warn: (message) => warnings.push(message) });
    try {
      const repo = addRepo(own, 'corrupt-shop');
      const made = own.changes.applyPlan(repo.id, { create: [branchFields('c')], update: [], archive: [] }, T0).created[0];
      if (made === undefined) throw new Error('not created');
      const input = snapshotInput(made.id, made.head, { contentHash: 'h1', fingerprints: fp('A') });
      own.snapshots.put(input);
      const raw = rawConnection(path);
      try {
        raw.prepare<[string]>('UPDATE snapshots SET fingerprints = ?').run('{not json SECRET-TEXT');
      } finally {
        raw.close();
      }
      expect(own.snapshots.put(input)).toBe('refreshed');
      expect(own.snapshots.latestFingerprints(made.id)).toBe(fp('A'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain('SECRET-TEXT');
    } finally {
      own.close();
      remove();
    }
  });
});

