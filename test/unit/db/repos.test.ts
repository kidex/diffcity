// The repos store and the RepoSummary counters (ADR-017, ADR-018, SPEC.md sections 6 and 8).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { T0, addRepo, branchFields, daysAfter, sha, snapshotInput, tempDb, type TempDb, rawConnection } from './db-helpers.js';

let temp: TempDb;
let db: Db;

beforeEach(() => {
  temp = tempDb();
  db = temp.db;
});
afterEach(() => {
  temp.cleanup();
});

describe('repos', () => {
  it('upsert registers a new repo once, by gitCommonDir', () => {
    const first = db.repos.upsert({
      path: '/work/sample-shop',
      gitCommonDir: '/work/sample-shop/.git',
      name: 'sample-shop',
      active: true,
      seenAt: T0,
    });
    expect(first).toEqual({
      created: true,
      repo: {
        id: first.repo.id,
        path: '/work/sample-shop',
        gitCommonDir: '/work/sample-shop/.git',
        name: 'sample-shop',
        base: null,
        active: true,
        tier1Paths: null,
        lastAudit: null,
        lastSeenAt: T0,
        createdAt: T0,
        collectError: null,
      },
    });

    // Known repo: same row; active and lastSeenAt are left to setActive and touchSeen.
    const again = db.repos.upsert({
      path: '/work/sample-shop-moved',
      gitCommonDir: '/work/sample-shop/.git',
      name: 'sample-shop-moved',
      active: false,
      seenAt: daysAfter(T0, 3),
    });
    expect(again).toEqual({
      created: false,
      repo: { ...first.repo, path: '/work/sample-shop-moved', name: 'sample-shop-moved' },
    });
    expect(db.repos.list()).toHaveLength(1);
  });

  it('setters update one column and refuse an unknown id', () => {
    const repo = addRepo(db);
    db.repos.setActive(repo.id, false);
    db.repos.touchSeen(repo.id, daysAfter(T0, 2));
    db.repos.setBase(repo.id, 'origin/main');
    db.repos.setTier1Paths(repo.id, ['auth', 'billing']);
    db.repos.setCollectError(repo.id, 'git exited with code 128');

    expect(db.repos.get(repo.id)).toEqual({
      ...repo,
      active: false,
      lastSeenAt: daysAfter(T0, 2),
      base: 'origin/main',
      tier1Paths: ['auth', 'billing'],
      collectError: 'git exited with code 128',
    });

    db.repos.setCollectError(repo.id, null);
    db.repos.setTier1Paths(repo.id, null);
    expect(db.repos.getByGitCommonDir(repo.gitCommonDir)).toMatchObject({ collectError: null, tier1Paths: null });

    expect(() => {
      db.repos.setActive(999, true);
    }).toThrow(/repo 999 not found/);
    expect(db.repos.get(999)).toBeNull();
    expect(db.repos.getByGitCommonDir('/work/none/.git')).toBeNull();
  });
});

describe('repo summaries', () => {
  it('db/repo-summary-counters: live changes by kind, unreviewed, highFindings 0, lastAudit null', () => {
    const repo = addRepo(db);
    const { created } = db.changes.applyPlan(
      repo.id,
      {
        create: [
          branchFields('draft', { kind: 'draft', ref: 'draft:.' }),
          branchFields('cart-totals'),
          branchFields('checkout', { reviewState: 'approved' }),
          branchFields('refunds', { kind: 'pr', ref: 'pr:7', prNumber: 7, reviewState: 'in-review' }),
          branchFields('old-branch'),
        ],
        update: [],
        archive: [],
      },
      T0,
    );
    const old = created[4];
    if (old === undefined) throw new Error('not created');
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: old.id, reason: 'deleted' }] }, T0);

    const summary = db.repos.getSummary(repo.id);
    expect(summary).toEqual({
      id: repo.id,
      name: 'sample-shop',
      path: '/work/sample-shop',
      active: true,
      lastSeenAt: T0,
      lastEventAt: T0,
      counts: { draft: 1, branch: 2, pr: 1 },
      unreviewed: 2,
      highFindings: 0,
      archivedCount: 1,
      lastAudit: null,
      collecting: false,
      error: null,
      watch: 'full',
      notes: [],
    });
  });

  it('db/repo-summary-counters: a repo without changes or events has zero counters and no lastEventAt', () => {
    const repo = addRepo(db, 'docs-site', false);
    expect(db.repos.getSummary(repo.id)).toMatchObject({
      counts: { draft: 0, branch: 0, pr: 0 },
      unreviewed: 0,
      highFindings: 0,
      archivedCount: 0,
      lastAudit: null,
      lastEventAt: null,
      watch: 'off',
    });
    expect(db.repos.getSummary(999)).toBeNull();
  });

  it('highFindings is the stored part only: findings rows are not counted here (the served overlay counts them, DC-106)', () => {
    const repo = addRepo(db);
    const { created } = db.changes.applyPlan(
      repo.id,
      { create: [branchFields('cart-totals'), branchFields('archived')], update: [], archive: [] },
      T0,
    );
    const [live, archived] = created;
    if (live === undefined || archived === undefined) throw new Error('not created');
    const oldHead = sha();
    db.snapshots.put(snapshotInput(live.id, oldHead, { computedAt: T0 }));
    db.snapshots.put(snapshotInput(live.id, live.head, { computedAt: daysAfter(T0, 1) }));
    db.snapshots.put(snapshotInput(archived.id, archived.head));
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: archived.id, reason: 'deleted' }] }, T0);

    const raw = rawConnection(temp.path);
    const add = raw.prepare<[number, string, string, string]>(
      'INSERT INTO findings (changeId, head, finding, state) VALUES (?, ?, ?, ?)',
    );
    add.run(live.id, live.head, '{"severity":"high"}', 'open');
    add.run(live.id, oldHead, '{"severity":"high"}', 'open');
    add.run(archived.id, archived.head, '{"severity":"high"}', 'open');
    raw.close();

    expect(db.repos.getSummary(repo.id)?.highFindings).toBe(0);
  });

  it('db/stored-high-findings: the stored part sums openHigh of the latest snapshots of live changes without findings rows (DC-120)', () => {
    const repo = addRepo(db);
    const { created } = db.changes.applyPlan(
      repo.id,
      { create: [branchFields('ledger-post'), branchFields('ledger-overlaid'), branchFields('ledger-old'), branchFields('ledger-gone')], update: [], archive: [] },
      T0,
    );
    const [plain, overlaid, old, gone] = created;
    if (plain === undefined || overlaid === undefined || old === undefined || gone === undefined) throw new Error('not created');
    const withHigh = (openHigh: number): ReturnType<typeof snapshotInput>['summary'] => ({ ...snapshotInput(0, '').summary, openHigh });
    // Only the latest snapshot of a change counts.
    db.snapshots.put(snapshotInput(plain.id, sha(), { computedAt: T0, summary: withHigh(5), contentHash: 'h0' }));
    db.snapshots.put(snapshotInput(plain.id, plain.head, { computedAt: daysAfter(T0, 1), summary: withHigh(2) }));
    // A change with a rule state is counted on its served Report by the daemon, not here.
    db.snapshots.put(snapshotInput(overlaid.id, overlaid.head, { summary: withHigh(1) }));
    db.findings.setRuleState(overlaid.id, 'rule:size:abc', overlaid.head, 'intended', T0);
    // A snapshot stored before openHigh existed reads as 0.
    db.snapshots.put(snapshotInput(old.id, old.head));
    db.snapshots.put(snapshotInput(gone.id, gone.head, { summary: withHigh(4) }));
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: gone.id, reason: 'deleted' }] }, T0);

    expect(db.repos.getSummary(repo.id)?.highFindings).toBe(2);
    expect(db.repos.listSummaries().find((entry) => entry.id === repo.id)?.highFindings).toBe(2);
  });

  it('lastEventAt covers repo-level events and live changes, not archived ones', () => {
    const repo = addRepo(db);
    const { created } = db.changes.applyPlan(
      repo.id,
      {
        create: [
          branchFields('live', { lastEventAt: daysAfter(T0, 2) }),
          branchFields('gone', { lastEventAt: daysAfter(T0, 9) }),
        ],
        update: [],
        archive: [],
      },
      T0,
    );
    const gone = created[1];
    if (gone === undefined) throw new Error('not created');
    db.events.add({ repoId: repo.id, changeId: gone.id, type: 'commit', at: daysAfter(T0, 9), payload: null });
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: gone.id, reason: 'merged' }] }, daysAfter(T0, 10));
    expect(db.repos.getSummary(repo.id)?.lastEventAt).toBe(daysAfter(T0, 2));

    db.events.add({ repoId: repo.id, changeId: null, type: 'agent', at: daysAfter(T0, 5), payload: null });
    expect(db.repos.getSummary(repo.id)?.lastEventAt).toBe(daysAfter(T0, 5));
  });

  it('lastAudit exposes only its time', () => {
    const repo = addRepo(db);
    const raw = rawConnection(temp.path);
    raw
      .prepare<[string, number]>('UPDATE repos SET lastAudit = ? WHERE id = ?')
      .run(JSON.stringify({ at: T0, commit: sha(), model: 'model-x', rulesetVersion: '1' }), repo.id);
    raw.close();
    expect(db.repos.getSummary(repo.id)?.lastAudit).toEqual({ at: T0 });
  });

  it('lists summaries by lastEventAt desc, repos without events last, then by name', () => {
    const shop = addRepo(db, 'sample-shop');
    const orders = addRepo(db, 'order-service');
    const docs = addRepo(db, 'docs-site');
    const blog = addRepo(db, 'blog-engine');
    db.events.add({ repoId: shop.id, changeId: null, type: 'agent', at: daysAfter(T0, 1), payload: null });
    db.events.add({ repoId: orders.id, changeId: null, type: 'agent', at: daysAfter(T0, 3), payload: null });

    expect(db.repos.listSummaries().map((summary) => summary.id)).toEqual([orders.id, shop.id, blog.id, docs.id]);
  });

  it('merges the daemon runtime state when given', () => {
    const repo = addRepo(db);
    const [summary] = db.repos.listSummaries((record) => ({
      collecting: record.id === repo.id,
      watch: 'git-only',
      notes: [{ code: 'a-note', text: 'a note' }],
    }));
    expect(summary).toMatchObject({ collecting: true, watch: 'git-only', notes: [{ code: 'a-note', text: 'a note' }] });
  });
});
