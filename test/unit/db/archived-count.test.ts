// RepoSummary.archivedCount (DC-64, SPEC.md section 3a L7, ADR-019): the archive the
// Repo screen toggle counts. It moves on archive and purge, and not on a change that
// comes back, because an archived row is never reopened: the ref gets a new live row.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcile } from '../../../src/core/changes/reconcile.js';
import type { Discovered } from '../../../src/core/changes/types.js';
import type { Db } from '../../../src/core/db/index.js';
import type { RepoRecord } from '../../../src/core/model/types.js';
import { branch, discovered, worktree } from '../changes/builders.js';
import { T0, addRepo, branchFields, daysAfter, tempDb, type TempDb } from './db-helpers.js';

const A = 'a'.repeat(40);
const C = 'c'.repeat(40);

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

/** One collection: reconcile the stored changes against `found` and apply the plan at `at`. */
function collect(found: Discovered, at: string): void {
  const plan = reconcile(db.changes.listLive(repo.id), db.changes.listArchived(repo.id), found, new Date(at));
  db.changes.applyPlan(repo.id, plan, at);
}

const archivedCount = (): number | undefined => db.repos.getSummary(repo.id)?.archivedCount;
const liveCount = (): number => db.changes.listLive(repo.id).length;

const withBranch = (head: string): Discovered =>
  discovered({ worktrees: [worktree()], branches: [branch('feature/cart', head)] });
/** The branch is gone from the candidates; `merged` keeps it as a local branch (its tip is in the base). */
const withoutBranch = (merged: boolean): Discovered =>
  discovered({ worktrees: [worktree()], branches: [], localBranches: merged ? ['main', 'feature/cart'] : ['main'] });

describe('RepoSummary.archivedCount', () => {
  it('db/archived-count-on-archive: starts at 0 and counts a change once it is archived', () => {
    expect(archivedCount()).toBe(0);
    collect(withBranch(A), T0);
    expect(archivedCount()).toBe(0);
    collect(withoutBranch(true), daysAfter(T0, 1));
    expect(liveCount()).toBe(0);
    expect(archivedCount()).toBe(1);
  });

  it('db/archived-count-same-head: a merged change that comes back at the same head stays archived and is not recreated', () => {
    collect(withBranch(A), T0);
    collect(withoutBranch(true), daysAfter(T0, 1));
    collect(withBranch(A), daysAfter(T0, 2));
    expect(liveCount()).toBe(0);
    expect(archivedCount()).toBe(1);
  });

  it('db/archived-count-new-head: a new head makes a new live change; the archived one is still counted', () => {
    collect(withBranch(A), T0);
    collect(withoutBranch(true), daysAfter(T0, 1));
    collect(withBranch(C), daysAfter(T0, 2));
    expect(liveCount()).toBe(1);
    expect(archivedCount()).toBe(1);
    collect(withoutBranch(true), daysAfter(T0, 3));
    expect(archivedCount()).toBe(2);
  });

  it('db/archived-count-deleted: a deleted branch that comes back at the same head is a new live change, and the archive keeps its row', () => {
    collect(withBranch(A), T0);
    collect(withoutBranch(false), daysAfter(T0, 1));
    expect(archivedCount()).toBe(1);
    collect(withBranch(A), daysAfter(T0, 2));
    expect(liveCount()).toBe(1);
    expect(archivedCount()).toBe(1);
  });

  it('db/archived-count-purge: a purge past 90 days lowers the count, only for the repo that lost changes', () => {
    const other = addRepo(db, 'sample-bakery');
    const archive = (repoId: number, name: string, archivedAt: string): void => {
      const [change] = db.changes.applyPlan(repoId, { create: [branchFields(name)], update: [], archive: [] }, daysAfter(T0, -200)).created;
      if (change === undefined) throw new Error('not created');
      db.changes.applyPlan(repoId, { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] }, archivedAt);
    };
    archive(repo.id, 'old', daysAfter(T0, -91));
    archive(repo.id, 'edge', daysAfter(T0, -90));
    archive(other.id, 'recent', daysAfter(T0, -5));
    expect(archivedCount()).toBe(2);

    expect([...db.purgeArchivedByRepo(T0)]).toEqual([[repo.id, 1]]);
    expect(archivedCount()).toBe(1);
    expect(db.repos.getSummary(other.id)?.archivedCount).toBe(1);
    expect(db.purgeArchivedByRepo(T0).size).toBe(0);
  });

  it('db/archived-count-live-untouched: live changes are not counted, and `counts` still holds live changes only', () => {
    collect(withBranch(A), T0);
    expect(db.repos.getSummary(repo.id)).toMatchObject({ archivedCount: 0, counts: { draft: 0, branch: 1, pr: 0 } });
  });
});
