// The snapshots store: one row per (change, head), identical hash skipped, the latest by computedAt (ADR-018, SPEC.md 4.2).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import type { ChangeRecord } from '../../../src/core/model/types.js';
import { T0, addRepo, branchFields, daysAfter, sampleSummary, sha, snapshotInput, tempDb, type TempDb, rawConnection } from './db-helpers.js';

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
