// The sessions store (ADR-038, schema v4): a session seen by a hook, its
// digest, its links to changes, and the purge that takes links with their
// changes and orphan sessions in the same run.

import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { T0, addRepo, branchFields, daysAfter, tempDb, type TempDb } from './db-helpers.js';

let temps: TempDb[] = [];
afterEach(() => {
  for (const temp of temps) temp.cleanup();
  temps = [];
});

function open(): Db {
  const temp = tempDb();
  temps.push(temp);
  return temp.db;
}

const sighting = (repoId: number, sessionId: string, at = T0) => ({
  repoId,
  sessionId,
  transcriptPath: `/claude/projects/-work-sample-shop/${sessionId}.jsonl`,
  cwd: '/work/sample-shop',
  at,
});

function addChange(db: Db, repoId: number, name: string, overrides: Parameters<typeof branchFields>[1] = {}): number {
  const [created] = db.changes.applyPlan(repoId, { create: [branchFields(name, overrides)], update: [], archive: [] }, T0).created;
  if (created === undefined) throw new Error('no change created');
  return created.id;
}

describe('sessions store', () => {
  it('see inserts once per (repo, session) and updates the path and cwd', () => {
    const db = open();
    const repo = addRepo(db);
    const first = db.sessions.see(sighting(repo.id, 'aaaa0001'));
    expect(first).toMatchObject({ sessionId: 'aaaa0001', firstAt: T0, lastAt: T0, digest: null, parsedBytes: 0, parseError: null });
    const again = db.sessions.see({ ...sighting(repo.id, 'aaaa0001', daysAfter(T0, 1)), cwd: '/work/sample-shop/src' });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ cwd: '/work/sample-shop/src', firstAt: T0, lastAt: T0 });
  });

  it('storeDigest keeps the digest, the mirrored cursor and the times, and clears a parse error', () => {
    const db = open();
    const repo = addRepo(db);
    const row = db.sessions.see(sighting(repo.id, 'aaaa0001'));
    db.sessions.setParseError(row.id, 'read-failed');
    expect(db.sessions.get(row.id)?.parseError).toBe('read-failed');
    db.sessions.storeDigest(row.id, { digest: '{"format":1}', parsedBytes: 120, title: 'Cart totals', firstAt: '2026-08-31T09:00:00.000Z', lastAt: null });
    expect(db.sessions.get(row.id)).toMatchObject({
      digest: '{"format":1}',
      parsedBytes: 120,
      title: 'Cart totals',
      firstAt: '2026-08-31T09:00:00.000Z',
      lastAt: T0,
      parseError: null,
    });
  });

  it('link keeps the first head and moves the last one; forChange is newest first and limited', () => {
    const db = open();
    const repo = addRepo(db);
    const change = addChange(db, repo.id, 'cart');
    const ids = ['aaaa0001', 'aaaa0002', 'aaaa0003'].map((id, index) => {
      const row = db.sessions.see(sighting(repo.id, id, daysAfter(T0, index)));
      db.sessions.link(change, row.id, 'h1', T0);
      return row.id;
    });
    db.sessions.link(change, ids[0] ?? 0, 'h2', daysAfter(T0, 3));
    expect(db.sessions.links(ids[0] ?? 0)).toEqual([{ changeId: change, sessionRowId: ids[0], firstHead: 'h1', lastHead: 'h2', linkedAt: daysAfter(T0, 3) }]);
    expect(db.sessions.forChange(change, 2).map((row) => row.session.sessionId)).toEqual(['aaaa0003', 'aaaa0002']);
  });

  it('session/purged-with-change: purging a change takes its links, then the sessions it orphaned; linked and recent ones stay', () => {
    const db = open();
    const repo = addRepo(db);
    const old = addChange(db, repo.id, 'old');
    const live = addChange(db, repo.id, 'live');
    const gone = db.sessions.see(sighting(repo.id, 'aaaa0001'));
    const shared = db.sessions.see(sighting(repo.id, 'aaaa0002'));
    const recent = db.sessions.see(sighting(repo.id, 'aaaa0003', daysAfter(T0, 200)));
    db.sessions.link(old, gone.id, 'h', T0);
    db.sessions.link(old, shared.id, 'h', T0);
    db.sessions.link(live, shared.id, 'h', T0);
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: old, reason: 'merged' }] }, T0);

    expect(db.purgeArchived(daysAfter(T0, 200))).toBe(1);
    expect(db.sessions.get(gone.id)).toBeNull();
    expect(db.sessions.links(shared.id).map((link) => link.changeId)).toEqual([live]);
    // Linked to nothing, but active within the retention: kept.
    expect(db.sessions.get(recent.id)).not.toBeNull();
  });
});
