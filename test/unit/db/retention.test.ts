// Events, purgeArchived and the 90-day retention (ADR-018, ADR-019, SPEC.md section 3a L7).
// Time is passed in as `now`, so the clock is fixed by the test.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RETENTION_DAYS, type Db } from '../../../src/core/db/index.js';
import type { RepoRecord } from '../../../src/core/model/types.js';
import { T0, addRepo, branchFields, daysAfter, snapshotInput, tempDb, type TempDb } from './db-helpers.js';

let temp: TempDb;
let db: Db;
let repo: RepoRecord;

beforeEach(() => {
  temp = tempDb();
  db = temp.db;
  repo = addRepo(db);
});
afterEach(() => {
  temp.cleanup();
});

const NOW = '2026-12-31T12:00:00.000Z';

function count(table: string): number {
  const raw = new Database(temp.path, { readonly: true });
  try {
    return raw.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
  } finally {
    raw.close();
  }
}

/** A change archived at `archivedAt`. */
function archivedChange(name: string, archivedAt: string): number {
  const [change] = db.changes.applyPlan(repo.id, { create: [branchFields(name)], update: [], archive: [] }, T0).created;
  if (change === undefined) throw new Error('not created');
  db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] }, archivedAt);
  return change.id;
}

describe('events', () => {
  it('adds and lists events with a JSON payload, latest first', () => {
    const first = db.events.add({ repoId: repo.id, changeId: null, type: 'agent', at: T0, payload: { dir: '/work/sample-shop' } });
    const second = db.events.add({ repoId: repo.id, changeId: null, type: 'collect', at: daysAfter(T0, 1), payload: null });

    expect(first).toEqual({ id: first.id, repoId: repo.id, changeId: null, type: 'agent', at: T0, payload: { dir: '/work/sample-shop' } });
    expect(db.events.listForRepo(repo.id)).toEqual([second, first]);
  });

  it('db/collect-events-pruned: collect events older than 90 days are deleted, other types stay', () => {
    const old = db.events.add({ repoId: repo.id, changeId: null, type: 'collect', at: daysAfter(NOW, -91), payload: null });
    const exactly90 = db.events.add({ repoId: repo.id, changeId: null, type: 'collect', at: daysAfter(NOW, -90), payload: null });
    const recent = db.events.add({ repoId: repo.id, changeId: null, type: 'collect', at: daysAfter(NOW, -89), payload: null });
    const oldAgent = db.events.add({ repoId: repo.id, changeId: null, type: 'agent', at: daysAfter(NOW, -200), payload: null });

    expect(RETENTION_DAYS).toBe(90);
    expect(db.events.pruneCollect(NOW)).toBe(1);
    expect(db.events.listForRepo(repo.id).map((event) => event.id)).toEqual([recent.id, exactly90.id, oldAgent.id]);
    expect(db.events.listForRepo(repo.id).map((event) => event.id)).not.toContain(old.id);
  });
});

describe('purgeArchived', () => {
  it('db/purge-89-90-91-days: L7 archived changes are deleted only once more than 90 days old', () => {
    const at89 = archivedChange('day-89', daysAfter(NOW, -89));
    const at90 = archivedChange('day-90', daysAfter(NOW, -90));
    const at91 = archivedChange('day-91', daysAfter(NOW, -91));
    const justOver = archivedChange('day-90-plus-1ms', new Date(Date.parse(daysAfter(NOW, -90)) - 1).toISOString());
    const [live] = db.changes.applyPlan(
      repo.id,
      { create: [branchFields('live', { lastEventAt: daysAfter(NOW, -400) })], update: [], archive: [] },
      daysAfter(NOW, -400),
    ).created;

    expect(db.purgeArchived(NOW)).toBe(2);

    expect(db.changes.listArchived(repo.id).map((change) => change.id).sort()).toEqual([at89, at90].sort());
    expect(db.changes.get(at91)).toBeNull();
    expect(db.changes.get(justOver)).toBeNull();
    expect(db.changes.listLive(repo.id)).toEqual([live]);
  });

  it('db/purge-cascades: L7 snapshots, findings and events of a purged change go with it', () => {
    const purged = archivedChange('purged', daysAfter(NOW, -91));
    const kept = archivedChange('kept', daysAfter(NOW, -10));
    for (const changeId of [purged, kept]) {
      const change = db.changes.get(changeId);
      if (change === null) throw new Error('missing');
      db.snapshots.put(snapshotInput(changeId, change.head));
      db.events.add({ repoId: repo.id, changeId, type: 'commit', at: T0, payload: null });
    }
    const repoEvent = db.events.add({ repoId: repo.id, changeId: null, type: 'agent', at: T0, payload: null });

    // No findings store until phase 4: rows are written through a plain connection.
    const raw = new Database(temp.path);
    const addFinding = raw.prepare<[number, string]>(
      `INSERT INTO findings (changeId, head, finding, state) VALUES (?, ?, '{"severity":"high"}', 'open')`,
    );
    for (const changeId of [purged, kept]) addFinding.run(changeId, db.changes.get(changeId)?.head ?? '');
    raw.close();

    expect(db.purgeArchived(NOW)).toBe(1);

    expect(count('changes')).toBe(1);
    expect(count('snapshots')).toBe(1);
    expect(count('findings')).toBe(1);
    expect(db.snapshots.latest(purged)).toBeNull();
    expect(db.snapshots.latest(kept)).not.toBeNull();
    expect(db.events.listForRepo(repo.id).map((event) => event.changeId).sort()).toEqual([kept, null].sort());
    expect(db.events.listForRepo(repo.id).map((event) => event.id)).toContain(repoEvent.id);
  });

  it('runs inside a transaction grouped with other writes', () => {
    const purged = archivedChange('purged', daysAfter(NOW, -91));
    expect(() =>
      db.transaction(() => {
        db.purgeArchived(NOW);
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(db.changes.get(purged)).not.toBeNull();
  });
});
