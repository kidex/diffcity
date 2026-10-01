// The changes store: applyPlan, the live-ref index and archive (ADR-018, ADR-019, SPEC.md section 3a L7).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedColumns } from '../../../src/core/changes/index.js';
import type { Db } from '../../../src/core/db/index.js';
import type { RepoRecord } from '../../../src/core/model/types.js';
import { T0, addRepo, branchFields, daysAfter, sampleSummary, sha, snapshotInput, tempDb, type TempDb } from './db-helpers.js';

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

const NOW = daysAfter(T0, 1);

describe('applyPlan', () => {
  it('creates changes with the plan fields, stamping updatedAt with now', () => {
    const fields = branchFields('cart-totals', { ahead: 3, behind: 1, worktreePath: '/work/sample-shop' });
    const { created, updated, archived } = db.changes.applyPlan(repo.id, { create: [fields], update: [], archive: [] }, NOW);

    expect(updated).toEqual([]);
    expect(archived).toEqual([]);
    expect(created).toEqual([
      { ...fields, id: created[0]?.id, repoId: repo.id, updatedAt: NOW, archivedAt: null, archiveReason: null },
    ]);
    expect(db.changes.get(created[0]?.id ?? -1)).toEqual(created[0]);
  });

  it('updates only the given columns and keeps the id, review state and events (branch gets a PR)', () => {
    const [branch] = db.changes.applyPlan(
      repo.id,
      { create: [branchFields('cart-totals', { reviewState: 'in-review' })], update: [], archive: [] },
      T0,
    ).created;
    if (branch === undefined) throw new Error('not created');
    db.events.add({ repoId: repo.id, changeId: branch.id, type: 'commit', at: T0, payload: null });

    const { updated } = db.changes.applyPlan(
      repo.id,
      { create: [], update: [{ id: branch.id, kind: 'pr', ref: 'pr:12', prNumber: 12, title: 'Cart totals' }], archive: [] },
      NOW,
    );

    expect(updated).toEqual([
      { ...branch, kind: 'pr', ref: 'pr:12', prNumber: 12, title: 'Cart totals', updatedAt: NOW },
    ]);
    expect(db.events.listForRepo(repo.id).map((event) => event.changeId)).toEqual([branch.id]);
  });

  it('can set nullable columns back to null', () => {
    const [change] = db.changes.applyPlan(
      repo.id,
      { create: [branchFields('cart-totals', { worktreePath: '/work/sample-shop' })], update: [], archive: [] },
      T0,
    ).created;
    if (change === undefined) throw new Error('not created');
    db.changes.applyPlan(
      repo.id,
      { create: [], update: [{ id: change.id, worktreePath: null, ahead: null, behind: null, headAvailable: false }], archive: [] },
      NOW,
    );
    expect(db.changes.get(change.id)).toMatchObject({ worktreePath: null, ahead: null, behind: null, headAvailable: false });
  });

  it('L7: archives with archivedAt = now and the reason', () => {
    const [change] = db.changes.applyPlan(repo.id, { create: [branchFields('cart-totals')], update: [], archive: [] }, T0)
      .created;
    if (change === undefined) throw new Error('not created');
    const { archived } = db.changes.applyPlan(
      repo.id,
      { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] },
      NOW,
    );

    expect(archived).toEqual([{ ...change, archivedAt: NOW, archiveReason: 'merged', updatedAt: NOW }]);
    expect(db.changes.listLive(repo.id)).toEqual([]);
    expect(db.changes.listArchived(repo.id)).toEqual(archived);
  });

  it('rolls the whole plan back when one step fails', () => {
    const [kept] = db.changes.applyPlan(repo.id, { create: [branchFields('kept')], update: [], archive: [] }, T0).created;
    if (kept === undefined) throw new Error('not created');

    expect(() =>
      db.changes.applyPlan(
        repo.id,
        {
          create: [branchFields('new-one')],
          update: [{ id: kept.id, title: 'Renamed' }],
          archive: [{ id: 9999, reason: 'deleted' }],
        },
        NOW,
      ),
    ).toThrow(/change 9999 not found/);
    expect(db.changes.listLive(repo.id)).toEqual([kept]);
  });

  it('refuses ids of another repo and archived changes', () => {
    const other = addRepo(db, 'order-service');
    const [foreign] = db.changes.applyPlan(other.id, { create: [branchFields('refunds')], update: [], archive: [] }, T0)
      .created;
    if (foreign === undefined) throw new Error('not created');
    expect(() =>
      db.changes.applyPlan(repo.id, { create: [], update: [{ id: foreign.id, title: 'x' }], archive: [] }, NOW),
    ).toThrow(/belongs to repo/);

    db.changes.applyPlan(other.id, { create: [], update: [], archive: [{ id: foreign.id, reason: 'deleted' }] }, NOW);
    expect(() =>
      db.changes.applyPlan(other.id, { create: [], update: [{ id: foreign.id, title: 'x' }], archive: [] }, NOW),
    ).toThrow(/is archived/);
    expect(() =>
      db.changes.applyPlan(other.id, { create: [], update: [], archive: [{ id: foreign.id, reason: 'deleted' }] }, NOW),
    ).toThrow(/is archived/);
  });

  it('rejects times without a zone', () => {
    expect(() =>
      db.changes.applyPlan(repo.id, { create: [branchFields('x')], update: [], archive: [] }, '2026-09-01T10:00:00'),
    ).toThrow(/ISO 8601/);
    expect(() =>
      db.changes.applyPlan(
        repo.id,
        { create: [branchFields('x', { lastEventAt: 'yesterday' })], update: [], archive: [] },
        NOW,
      ),
    ).toThrow(/lastEventAt/);
  });

  it('normalizes times with an offset to UTC', () => {
    const [change] = db.changes.applyPlan(
      repo.id,
      { create: [branchFields('x', { lastEventAt: '2026-09-01T12:00:00+02:00' })], update: [], archive: [] },
      '2026-09-02T03:00:00+03:00',
    ).created;
    expect(change).toMatchObject({ lastEventAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' });
  });

  it('rejects values outside the CHECK constraints', () => {
    expect(() =>
      db.changes.applyPlan(
        repo.id,
        // @ts-expect-error: an invalid kind must be refused by the schema, not only by the type.
        { create: [branchFields('x', { kind: 'tag' })], update: [], archive: [] },
        NOW,
      ),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('live ref uniqueness', () => {
  it('db/live-ref-unique: two live changes with the same ref are refused', () => {
    db.changes.applyPlan(repo.id, { create: [branchFields('cart-totals')], update: [], archive: [] }, T0);

    expect(() =>
      db.changes.applyPlan(repo.id, { create: [branchFields('cart-totals')], update: [], archive: [] }, NOW),
    ).toThrow(/UNIQUE constraint failed: changes.repoId, changes.ref/);
    expect(() =>
      db.changes.applyPlan(
        repo.id,
        { create: [branchFields('checkout'), branchFields('checkout')], update: [], archive: [] },
        NOW,
      ),
    ).toThrow(/UNIQUE constraint failed/);
    expect(db.changes.listLive(repo.id).map((change) => change.ref)).toEqual(['branch:cart-totals']);
  });

  it('db/live-ref-unique: the same ref is allowed in another repo', () => {
    const other = addRepo(db, 'order-service');
    db.changes.applyPlan(repo.id, { create: [branchFields('cart-totals')], update: [], archive: [] }, T0);
    db.changes.applyPlan(other.id, { create: [branchFields('cart-totals')], update: [], archive: [] }, T0);
    expect(db.changes.listLive(other.id)).toHaveLength(1);
  });

  it('db/archived-ref-reusable: L7 an archived ref can be taken by a new live change', () => {
    const [old] = db.changes.applyPlan(repo.id, { create: [branchFields('cart-totals')], update: [], archive: [] }, T0)
      .created;
    if (old === undefined) throw new Error('not created');
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: old.id, reason: 'merged' }] }, NOW);

    const [reborn] = db.changes.applyPlan(
      repo.id,
      { create: [branchFields('cart-totals')], update: [], archive: [] },
      daysAfter(NOW, 1),
    ).created;

    expect(reborn?.id).not.toBe(old.id);
    expect(db.changes.listLive(repo.id).map((change) => change.id)).toEqual([reborn?.id]);
    expect(db.changes.listArchived(repo.id).map((change) => change.id)).toEqual([old.id]);
  });

  it('db/archived-ref-reusable: archive and create of the same ref work in one plan', () => {
    const [draft] = db.changes.applyPlan(
      repo.id,
      { create: [branchFields('x', { kind: 'draft', ref: 'draft:.' })], update: [], archive: [] },
      T0,
    ).created;
    if (draft === undefined) throw new Error('not created');

    const result = db.changes.applyPlan(
      repo.id,
      {
        create: [branchFields('x', { kind: 'draft', ref: 'draft:.' })],
        update: [],
        archive: [{ id: draft.id, reason: 'clean' }],
      },
      NOW,
    );
    expect(result.archived.map((change) => change.ref)).toEqual(['draft:.']);
    expect(result.created.map((change) => change.ref)).toEqual(['draft:.']);
  });
});

describe('lists and summaries', () => {
  it('lists live changes by lastEventAt desc and archived ones by archivedAt desc', () => {
    const { created } = db.changes.applyPlan(
      repo.id,
      {
        create: [
          branchFields('a', { lastEventAt: daysAfter(T0, 1) }),
          branchFields('b', { lastEventAt: daysAfter(T0, 3) }),
          branchFields('c', { lastEventAt: daysAfter(T0, 2) }),
          branchFields('d'),
          branchFields('e'),
        ],
        update: [],
        archive: [],
      },
      T0,
    );
    const [, , , d, e] = created;
    if (d === undefined || e === undefined) throw new Error('not created');
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: e.id, reason: 'deleted' }] }, daysAfter(T0, 4));
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: d.id, reason: 'merged' }] }, daysAfter(T0, 5));

    expect(db.changes.listLive(repo.id).map((change) => change.ref)).toEqual(['branch:b', 'branch:c', 'branch:a']);
    expect(db.changes.listArchived(repo.id).map((change) => change.ref)).toEqual(['branch:d', 'branch:e']);
    expect(db.changes.listLiveSummaries(repo.id).map((change) => change.ref)).toEqual(['branch:b', 'branch:c', 'branch:a']);
    expect(db.changes.listArchivedSummaries(repo.id).map((change) => change.ref)).toEqual(['branch:d', 'branch:e']);
  });

  it('builds ChangeSummary from the latest snapshot summary without parsing the report', () => {
    const fields = branchFields('cart-totals', { lastEventType: 'agent', dirty: true });
    const [change] = db.changes.applyPlan(repo.id, { create: [fields], update: [], archive: [] }, T0).created;
    if (change === undefined) throw new Error('not created');

    expect(db.changes.getSummary(change.id)?.stats).toBeNull();

    // The report holds nothing the summary could be derived from: stats must come from `summary`.
    db.snapshots.put(snapshotInput(change.id, change.head, { report: '[]', summary: sampleSummary({ touchedFiles: 7 }) }));

    expect(db.changes.getSummary(change.id)).toEqual({
      id: change.id,
      repoId: repo.id,
      kind: 'branch',
      ref: 'branch:cart-totals',
      prNumber: null,
      head: change.head,
      headAvailable: true,
      dirty: true,
      base: 'main',
      title: 'Add cart-totals',
      ahead: 2,
      behind: 0,
      reviewState: 'unreviewed',
      agentUnreviewed: true,
      lastEvent: { type: 'agent', at: T0 },
      updatedAt: T0,
      archivedAt: null,
      archiveReason: null,
      stats: {
        touchedFiles: 7,
        symbolsByStatus: { add: 2, mod: 1, sig: 1, del: 0, same: 6 },
        filesByVerdict: { eyes: 1, risky: 0, spec: 0, ok: 1, same: 2 },
        tier1Files: ['src/auth/session.ts'],
      },
    });
  });

  it('agentUnreviewed needs both an agent last event and the unreviewed state', () => {
    const { created } = db.changes.applyPlan(
      repo.id,
      {
        create: [
          branchFields('agent-reviewing', { lastEventType: 'agent', reviewState: 'in-review' }),
          branchFields('commit-unreviewed', { lastEventType: 'commit' }),
          branchFields('agent-unreviewed', { lastEventType: 'agent' }),
        ],
        update: [],
        archive: [],
      },
      T0,
    );
    expect(created.map((change) => db.changes.getSummary(change.id)?.agentUnreviewed)).toEqual([false, false, true]);
  });

  it('stats follow the latest snapshot by computedAt', () => {
    const [change] = db.changes.applyPlan(repo.id, { create: [branchFields('x')], update: [], archive: [] }, T0).created;
    if (change === undefined) throw new Error('not created');
    db.snapshots.put(
      snapshotInput(change.id, sha(), { computedAt: daysAfter(T0, 2), summary: sampleSummary({ touchedFiles: 9 }) }),
    );
    db.snapshots.put(
      snapshotInput(change.id, sha(), { computedAt: daysAfter(T0, 1), summary: sampleSummary({ touchedFiles: 3 }) }),
    );
    expect(db.changes.getSummary(change.id)?.stats?.touchedFiles).toBe(9);
  });

  it('get and getSummary return null for an unknown id', () => {
    expect(db.changes.get(42)).toBeNull();
    expect(db.changes.getSummary(42)).toBeNull();
  });
});

describe('round trip with reconcile (DC-26)', () => {
  it('stored records have real booleans and numbers, so changedColumns sees no change', () => {
    const fieldSets = [
      branchFields('refunds', { kind: 'pr', ref: 'pr:7', prNumber: 7, ahead: 3, behind: 1, dirty: true, headAvailable: true }),
      branchFields('not-fetched', {
        kind: 'pr',
        ref: 'pr:8',
        prNumber: 8,
        ahead: null,
        behind: null,
        dirty: false,
        headAvailable: false,
      }),
      branchFields('draft', { kind: 'draft', ref: 'draft:.', worktreePath: '/work/sample-shop', ahead: 0, behind: 0 }),
    ];
    db.changes.applyPlan(repo.id, { create: fieldSets, update: [], archive: [] }, NOW);

    const stored = db.changes.listLive(repo.id);
    expect(stored).toHaveLength(fieldSets.length);
    for (const fields of fieldSets) {
      const record = stored.find((change) => change.ref === fields.ref);
      if (record === undefined) throw new Error(`missing ${fields.ref}`);
      expect(typeof record.dirty).toBe('boolean');
      expect(typeof record.headAvailable).toBe('boolean');
      for (const value of [record.prNumber, record.ahead, record.behind]) {
        expect(value === null || typeof value === 'number').toBe(true);
      }
      expect(changedColumns(record, fields)).toBeNull();
      expect(changedColumns(db.changes.get(record.id) ?? record, fields)).toBeNull();
    }
  });
});
