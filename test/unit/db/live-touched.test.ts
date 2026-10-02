// snapshots.liveTouched: the touched paths of each live change's latest
// snapshot, for search (ADR-017, ADR-018).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { T0, addRepo, branchFields, daysAfter, sha, snapshotInput, tempDb, type TempDb } from './db-helpers.js';

let temp: TempDb;
let db: Db;

beforeEach(() => {
  temp = tempDb();
  db = temp.db;
});
afterEach(() => {
  temp.cleanup();
});

describe('snapshots.liveTouched', () => {
  it('lists the latest snapshot of live changes only, by last event desc', () => {
    const repo = addRepo(db);
    const [older, newer, archived, computing] = db.changes.applyPlan(
      repo.id,
      {
        create: [
          branchFields('older', { lastEventAt: T0 }),
          branchFields('newer', { lastEventAt: daysAfter(T0, 1) }),
          branchFields('gone', { lastEventAt: daysAfter(T0, 2) }),
          branchFields('computing', { lastEventAt: daysAfter(T0, 3) }),
        ],
        update: [],
        archive: [],
      },
      T0,
    ).created;
    if (older === undefined || newer === undefined || archived === undefined || computing === undefined) throw new Error('not created');

    db.snapshots.put(snapshotInput(older.id, older.head, { touched: ['src/old.ts'] }));
    db.snapshots.put(snapshotInput(older.id, sha(), { touched: ['src/latest.ts'], contentHash: 'h2', computedAt: daysAfter(T0, 1) }));
    db.snapshots.put(snapshotInput(newer.id, newer.head, { touched: ['src/newer.ts'] }));
    db.snapshots.put(snapshotInput(archived.id, archived.head, { touched: ['src/gone.ts'] }));
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: archived.id, reason: 'deleted' }] }, T0);

    expect(db.snapshots.liveTouched()).toEqual([
      { repoId: repo.id, changeId: newer.id, touched: ['src/newer.ts'] },
      { repoId: repo.id, changeId: older.id, touched: ['src/latest.ts'] },
    ]);
  });
});
