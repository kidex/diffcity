// purgeArchived at 90 days (SPEC.md section 3a L7, ADR-018, ADR-019): a purged
// change takes every snapshot (all heads), every finding and every event type
// with it; repo-level events, live changes, recent archives and other repos stay.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import type { EventType, RepoRecord } from '../../../src/core/model/types.js';
import { addRepo, branchFields, daysAfter, sha, snapshotInput, tempDb, type TempDb } from './db-helpers.js';

const NOW = '2027-01-15T12:00:00.000Z';
const EVENT_TYPES: EventType[] = ['collect', 'agent', 'commit', 'review', 'import', 'audit'];

let temp: TempDb;
let db: Db;

beforeEach(() => {
  temp = tempDb();
  db = temp.db;
});
afterEach(() => {
  temp.cleanup();
});

/** A change with snapshots on three heads, two findings per head and one event of each type; archived at `archivedAt` when given. */
function populatedChange(repo: RepoRecord, name: string, archivedAt: string | null): number {
  const createdAt = daysAfter(NOW, -200);
  const [change] = db.changes.applyPlan(repo.id, { create: [branchFields(name, { lastEventAt: createdAt })], update: [], archive: [] }, createdAt)
    .created;
  if (change === undefined) throw new Error('not created');
  const heads = [change.head, sha(), sha()];
  heads.forEach((head, i) => {
    db.snapshots.put(snapshotInput(change.id, head, { contentHash: `${name}-${String(i)}`, computedAt: daysAfter(createdAt, i) }));
  });
  for (const type of EVENT_TYPES) db.events.add({ repoId: repo.id, changeId: change.id, type, at: daysAfter(NOW, -1), payload: { name } });

  const raw = new Database(temp.path);
  const addFinding = raw.prepare<[number, string, string]>(
    "INSERT INTO findings (changeId, head, finding, state) VALUES (?, ?, '{\"severity\":\"high\"}', ?)",
  );
  for (const head of heads) {
    addFinding.run(change.id, head, 'open');
    addFinding.run(change.id, head, 'intended');
  }
  raw.close();

  if (archivedAt !== null) db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] }, archivedAt);
  return change.id;
}

function counts(changeId: number): Record<'snapshots' | 'findings' | 'events', number> {
  const raw = new Database(temp.path, { readonly: true });
  try {
    const n = (table: string): number =>
      raw.prepare<[number], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE changeId = ?`).get(changeId)?.n ?? -1;
    return { snapshots: n('snapshots'), findings: n('findings'), events: n('events') };
  } finally {
    raw.close();
  }
}

describe('purgeArchived cascade', () => {
  it('db/purge-cascades: L7 a change archived 91 days ago goes with all its snapshots, findings and events', () => {
    const shop = addRepo(db, 'sample-shop');
    const other = addRepo(db, 'other-shop');
    const old = populatedChange(shop, 'old-merged', daysAfter(NOW, -91));
    const recent = populatedChange(shop, 'recent-merged', daysAfter(NOW, -89));
    const live = populatedChange(shop, 'still-live', null);
    const otherOld = populatedChange(other, 'other-recent', daysAfter(NOW, -30));
    const repoEvent = db.events.add({ repoId: shop.id, changeId: null, type: 'agent', at: daysAfter(NOW, -120), payload: null });

    const full = { snapshots: 3, findings: 6, events: 6 };
    expect(counts(old)).toEqual(full);

    expect(db.purgeArchived(NOW)).toBe(1);

    expect(db.changes.get(old)).toBeNull();
    expect(counts(old)).toEqual({ snapshots: 0, findings: 0, events: 0 });
    for (const kept of [recent, live, otherOld]) expect(counts(kept)).toEqual(full);
    expect(db.events.listForRepo(shop.id).map((event) => event.id)).toContain(repoEvent.id);
    expect(db.repos.list().map((repo) => repo.name).sort()).toEqual(['other-shop', 'sample-shop']);

    const raw = new Database(temp.path, { readonly: true });
    try {
      expect(raw.pragma('foreign_key_check')).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('a second purge at the same time deletes nothing more', () => {
    const shop = addRepo(db);
    populatedChange(shop, 'old-closed', daysAfter(NOW, -120));
    expect(db.purgeArchived(NOW)).toBe(1);
    expect(db.purgeArchived(NOW)).toBe(0);
  });

  it('pruneCollect after a purge leaves the other event types of surviving changes', () => {
    const shop = addRepo(db);
    const kept = populatedChange(shop, 'kept', daysAfter(NOW, -10));
    db.events.add({ repoId: shop.id, changeId: kept, type: 'collect', at: daysAfter(NOW, -95), payload: null });
    db.purgeArchived(NOW);
    expect(db.events.pruneCollect(NOW)).toBe(1);
    expect(counts(kept).events).toBe(EVENT_TYPES.length);
  });
});
