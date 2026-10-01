import { describe, expect, it } from 'vitest';
import { reconcile, reviewAfterSnapshot } from '../../../src/core/changes/reconcile.js';
import { NOW, NOW_ISO, REPO, branch, discovered, pr, record, sha, worktree } from './builders.js';

const A = sha('a1');
const B = sha('b1');
const C = sha('c1');

describe('reconcile: sources to candidates (ADR-019)', () => {
  it('changes/draft-on-base (L1): a dirty working tree on the base becomes a Draft', () => {
    const plan = reconcile([], [], discovered({ worktrees: [worktree({ dirty: true })] }), NOW);
    expect(plan.create).toEqual([
      {
        kind: 'draft',
        ref: 'draft:.',
        prNumber: null,
        head: sha('ba5e'),
        headAvailable: true,
        dirty: true,
        worktreePath: REPO,
        base: 'main',
        title: 'Uncommitted changes on main',
        ahead: 0,
        behind: 0,
        reviewState: 'unreviewed',
        lastEventType: 'commit',
        lastEventAt: '2026-03-01T09:00:00.000Z',
      },
    ]);
    expect(plan.update).toEqual([]);
    expect(plan.archive).toEqual([]);
  });

  it('a clean working tree on the base produces nothing', () => {
    expect(reconcile([], [], discovered(), NOW)).toEqual({ create: [], update: [], archive: [] });
  });

  it('changes/draft-on-branch-folds (L1, L4, Q2): dirty on a branch with commits ahead is one change, dirty', () => {
    const plan = reconcile(
      [],
      [],
      discovered({
        worktrees: [worktree({ head: A, branch: 'feature/cart', dirty: true, ahead: 2 })],
        branches: [branch('feature/cart', A)],
      }),
      NOW,
    );
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]).toMatchObject({
      kind: 'branch',
      ref: 'branch:feature/cart',
      head: A,
      dirty: true,
      worktreePath: REPO,
      title: 'first commit of feature/cart',
    });
  });

  it('a dirty working tree on a branch with no commits ahead becomes a Draft (Q2)', () => {
    const plan = reconcile(
      [],
      [],
      discovered({ worktrees: [worktree({ branch: 'feature/empty', dirty: true })], localBranches: ['main', 'feature/empty'] }),
      NOW,
    );
    expect(plan.create).toEqual([expect.objectContaining({ kind: 'draft', title: 'Uncommitted changes on feature/empty' })]);
  });

  it('changes/draft-detached (L1, Q2): dirty on a detached HEAD becomes a Draft without a branch in its title', () => {
    const plan = reconcile([], [], discovered({ worktrees: [worktree({ head: C, branch: null, dirty: true, ahead: 1 })] }), NOW);
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'draft', head: C, title: 'Uncommitted changes', ahead: 1, dirty: true }),
    ]);
  });

  it('a clean detached HEAD with commits on no branch produces nothing', () => {
    const plan = reconcile([], [], discovered({ worktrees: [worktree({ head: C, branch: null, ahead: 1 })] }), NOW);
    expect(plan.create).toEqual([]);
  });

  it('changes/linked-worktree-same-repo (L1, Q2): a linked worktree gets a Draft ref relative to the main working tree', () => {
    const plan = reconcile(
      [],
      [],
      discovered({ worktrees: [worktree(), worktree({ path: `${REPO}/.worktrees/agent`, branch: null, dirty: true })] }),
      NOW,
    );
    expect(plan.create).toEqual([
      expect.objectContaining({ ref: 'draft:.worktrees/agent', worktreePath: `${REPO}/.worktrees/agent` }),
    ]);
  });

  it('changes/two-dirty-worktrees-same-head (L4, Q2): two dirty working trees at the same HEAD are two Drafts', () => {
    const linked = '/work/sample-shop-agent';
    const plan = reconcile(
      [],
      [],
      discovered({ worktrees: [worktree({ dirty: true }), worktree({ path: linked, branch: null, dirty: true })] }),
      NOW,
    );
    expect(plan.create.map((change) => [change.ref, change.worktreePath])).toEqual([
      ['draft:.', REPO],
      ['draft:../sample-shop-agent', linked],
    ]);
  });

  it('two dirty working trees at the head of a branch: the one on the branch folds, the other is a Draft', () => {
    const linked = '/work/sample-shop-agent';
    const plan = reconcile(
      [],
      [],
      discovered({
        worktrees: [
          worktree({ head: A, branch: null, dirty: true, ahead: 2 }),
          worktree({ path: linked, head: A, branch: 'feature/cart', dirty: true, ahead: 2 }),
        ],
        branches: [branch('feature/cart', A)],
      }),
      NOW,
    );
    expect(plan.create.map((change) => [change.kind, change.ref, change.worktreePath, change.dirty])).toEqual([
      ['branch', 'branch:feature/cart', linked, true],
      ['draft', 'draft:.', REPO, true],
    ]);
  });

  it('a clean working tree on a branch with commits ahead only sets worktreePath', () => {
    const plan = reconcile(
      [],
      [],
      discovered({ worktrees: [worktree({ head: A, branch: 'feature/cart' })], branches: [branch('feature/cart', A)] }),
      NOW,
    );
    expect(plan.create).toEqual([expect.objectContaining({ kind: 'branch', dirty: false, worktreePath: REPO })]);
  });

  it('changes/branch-ahead (L2): a branch with commits ahead is a Branch with its counters', () => {
    const plan = reconcile([], [], discovered({ branches: [branch('feature/cart', A, { ahead: 3, behind: 2 })] }), NOW);
    expect(plan.create).toEqual([
      {
        kind: 'branch',
        ref: 'branch:feature/cart',
        prNumber: null,
        head: A,
        headAvailable: true,
        dirty: false,
        worktreePath: null,
        base: 'main',
        title: 'first commit of feature/cart',
        ahead: 3,
        behind: 2,
        reviewState: 'unreviewed',
        lastEventType: 'commit',
        lastEventAt: '2026-03-05T10:00:00.000Z',
      },
    ]);
  });

  it('changes/pr-from-gh (L3, L6 title-pr): an open PR is PR #N with its own base and title', () => {
    const plan = reconcile([], [], discovered({ prs: { available: true, open: [pr(12, B, { baseRefName: 'release' })], states: {} } }), NOW);
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'pr', ref: 'pr:12', prNumber: 12, head: B, base: 'release', title: 'PR title 12' }),
    ]);
  });

  it('changes/pr-head-not-local (L3, Q3): a PR whose head is not local has no counters and its event at detection time', () => {
    const plan = reconcile(
      [],
      [],
      discovered({
        prs: {
          available: true,
          open: [pr(12, B, { headAvailable: false, ahead: null, behind: null, committedAt: null })],
          states: {},
        },
      }),
      NOW,
    );
    expect(plan.create).toEqual([
      expect.objectContaining({ headAvailable: false, ahead: null, behind: null, lastEventType: 'commit', lastEventAt: NOW_ISO }),
    ]);
  });

  it('changes/branch-with-pr-same-head-once (L4): a branch and its PR at the same head appear once, as PR', () => {
    const plan = reconcile(
      [],
      [],
      discovered({
        worktrees: [worktree({ head: B, branch: 'feature/pr-12', dirty: true })],
        branches: [branch('feature/pr-12', B)],
        prs: { available: true, open: [pr(12, B)], states: {} },
      }),
      NOW,
    );
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'pr', ref: 'pr:12', head: B, dirty: true, worktreePath: REPO, title: 'PR title 12' }),
    ]);
  });

  it('changes/branch-ahead-of-pr-twice (L4): unpushed commits make the Branch and the PR two changes', () => {
    const plan = reconcile(
      [],
      [],
      discovered({ branches: [branch('feature/pr-12', A)], prs: { available: true, open: [pr(12, B)], states: {} } }),
      NOW,
    );
    expect(plan.create.map((change) => [change.kind, change.ref, change.head])).toEqual([
      ['pr', 'pr:12', B],
      ['branch', 'branch:feature/pr-12', A],
    ]);
  });

  it('changes/two-branches-same-head (L4): two branches on the same head are one change, the first ref alphabetically', () => {
    const plan = reconcile([], [], discovered({ branches: [branch('feature/zeta', A), branch('feature/alpha', A)] }), NOW);
    expect(plan.create.map((change) => change.ref)).toEqual(['branch:feature/alpha']);
  });

  it('two branches on the same head: the checked-out one wins over the alphabetical order', () => {
    const plan = reconcile(
      [],
      [],
      discovered({
        worktrees: [worktree({ head: A, branch: 'feature/zeta' })],
        branches: [branch('feature/alpha', A), branch('feature/zeta', A)],
      }),
      NOW,
    );
    expect(plan.create.map((change) => change.ref)).toEqual(['branch:feature/zeta']);
  });

  it('changes/title-draft (L6): `Uncommitted changes on <branch>`, or without a branch when detached', () => {
    const onBranch = reconcile([], [], discovered({ worktrees: [worktree({ dirty: true, branch: 'main' })] }), NOW);
    const detached = reconcile([], [], discovered({ worktrees: [worktree({ dirty: true, branch: null })] }), NOW);
    expect(onBranch.create[0]?.title).toBe('Uncommitted changes on main');
    expect(detached.create[0]?.title).toBe('Uncommitted changes');
  });
});

describe('reconcile: change identity, last event and review state (ADR-019)', () => {
  it('changes/identity-branch-gets-pr (L6): a branch that gets a PR keeps its id and review state', () => {
    const live = record({ id: 41, ref: 'branch:feature/pr-12', head: B, reviewState: 'in-review', title: 'old' });
    const plan = reconcile(
      [live],
      [],
      discovered({ branches: [branch('feature/pr-12', B)], prs: { available: true, open: [pr(12, B)], states: {} } }),
      NOW,
    );
    expect(plan.create).toEqual([]);
    expect(plan.archive).toEqual([]);
    // Only the columns that changed: the review state and the last event stay as stored.
    expect(plan.update).toEqual([{ id: 41, kind: 'pr', ref: 'pr:12', prNumber: 12, title: 'PR title 12', ahead: 3, behind: 1 }]);
  });

  it('a live change with nothing new produces no update', () => {
    const first = reconcile([], [], discovered({ branches: [branch('feature/cart', A)] }), NOW);
    const created = first.create[0];
    if (created === undefined) throw new Error('expected a created change');
    const live = record({ ...created, id: 5 });
    const later = new Date('2026-03-11T00:00:00.000Z');
    expect(reconcile([live], [], discovered({ branches: [branch('feature/cart', A)] }), later)).toEqual({
      create: [],
      update: [],
      archive: [],
    });
  });

  it('changes/last-event-commit-date (L6): a new head is a commit event at its committer date', () => {
    const live = record({ id: 5, ref: 'branch:feature/cart', head: A, lastEventAt: '2026-03-02T08:00:00.000Z' });
    const plan = reconcile(
      [live],
      [],
      discovered({ branches: [branch('feature/cart', B, { committedAt: '2026-03-08T07:30:00.000Z' })] }),
      NOW,
    );
    expect(plan.update[0]).toMatchObject({ head: B, lastEventAt: '2026-03-08T07:30:00.000Z' });
  });

  it('changes/last-event-commit-date (L6): the commit event never moves the last event backwards', () => {
    const live = record({ id: 5, ref: 'branch:feature/cart', head: A, lastEventType: 'agent', lastEventAt: '2026-03-09T00:00:00.000Z' });
    const plan = reconcile(
      [live],
      [],
      discovered({ branches: [branch('feature/cart', B, { committedAt: '2026-03-01T00:00:00.000Z' })] }),
      NOW,
    );
    expect(plan.update[0]).toMatchObject({ lastEventType: 'commit' });
    expect(plan.update[0]).not.toHaveProperty('lastEventAt');
  });

  it('changes/approved-reset-on-new-head (Q5): approved + a new head goes back to unreviewed', () => {
    const live = record({ id: 5, ref: 'branch:feature/cart', head: A, reviewState: 'approved' });
    const plan = reconcile([live], [], discovered({ branches: [branch('feature/cart', B)] }), NOW);
    expect(plan.update[0]?.reviewState).toBe('unreviewed');
  });

  it('approved stays approved while the head does not move', () => {
    const live = record({ id: 5, ref: 'branch:feature/cart', head: A, reviewState: 'approved', ahead: 1, title: 'first commit of feature/cart' });
    const plan = reconcile([live], [], discovered({ branches: [branch('feature/cart', A, { ahead: 1, behind: 4 })] }), NOW);
    expect(plan.update).toEqual([{ id: 5, behind: 4 }]);
  });

  it('changes/in-review-kept (Q5): in-review + a new head stays in-review', () => {
    const live = record({ id: 5, ref: 'branch:feature/cart', head: A, reviewState: 'in-review' });
    const plan = reconcile([live], [], discovered({ branches: [branch('feature/cart', B)] }), NOW);
    expect(plan.update[0]).toMatchObject({ head: B });
    expect(plan.update[0]).not.toHaveProperty('reviewState');
  });

  it('a Draft keeps its identity by worktree path when its HEAD moves', () => {
    const live = record({ id: 9, kind: 'draft', ref: 'draft:.', head: A, dirty: true, worktreePath: REPO, title: 'Uncommitted changes on main' });
    const plan = reconcile([live], [], discovered({ worktrees: [worktree({ head: B, dirty: true })] }), NOW);
    expect(plan.update).toMatchObject([{ id: 9, head: B }]);
    expect(plan.update[0]).not.toHaveProperty('kind');
    expect(plan.create).toEqual([]);
  });

  it('when a pushed branch catches up with its PR, the PR keeps its identity and the Branch is archived as merged', () => {
    const livePr = record({ id: 1, kind: 'pr', ref: 'pr:12', prNumber: 12, head: A });
    const liveBranch = record({ id: 2, ref: 'branch:feature/pr-12', head: B });
    const plan = reconcile(
      [livePr, liveBranch],
      [],
      discovered({ branches: [branch('feature/pr-12', B)], prs: { available: true, open: [pr(12, B)], states: {} } }),
      NOW,
    );
    expect(plan.update.map((update) => [update.id, update.head])).toEqual([[1, B]]);
    expect(plan.archive).toEqual([{ id: 2, reason: 'merged' }]);
  });
});

describe('reconcile: archive (L7)', () => {
  it('changes/archive-pr-merged (L7): a PR missing from the open list and MERGED is archived as merged', () => {
    const live = record({ id: 3, kind: 'pr', ref: 'pr:12', prNumber: 12, head: B });
    const plan = reconcile([live], [], discovered({ prs: { available: true, open: [], states: { 12: 'MERGED' } } }), NOW);
    expect(plan.archive).toEqual([{ id: 3, reason: 'merged' }]);
  });

  it('changes/archive-pr-closed (L7, Q4): a PR missing from the open list and CLOSED is archived as closed', () => {
    const live = record({ id: 3, kind: 'pr', ref: 'pr:12', prNumber: 12, head: B });
    const plan = reconcile([live], [], discovered({ prs: { available: true, open: [], states: { 12: 'CLOSED' } } }), NOW);
    expect(plan.archive).toEqual([{ id: 3, reason: 'closed' }]);
  });

  it('a PR missing from the open list with an unknown or OPEN state stays live', () => {
    const live = record({ id: 3, kind: 'pr', ref: 'pr:12', prNumber: 12, head: B });
    const unknown = reconcile([live], [], discovered({ prs: { available: true, open: [], states: {} } }), NOW);
    const open = reconcile([live], [], discovered({ prs: { available: true, open: [], states: { 12: 'OPEN' } } }), NOW);
    expect(unknown).toEqual({ create: [], update: [], archive: [] });
    expect(open).toEqual({ create: [], update: [], archive: [] });
  });

  it('changes/no-archive-when-gh-down (L7): with gh unavailable the PR stays live and its branch is not duplicated', () => {
    const live = record({ id: 3, kind: 'pr', ref: 'pr:12', prNumber: 12, head: B, worktreePath: null });
    const plan = reconcile(
      [live],
      [],
      discovered({ branches: [branch('feature/pr-12', B)], prs: { available: false } }),
      NOW,
    );
    expect(plan).toEqual({ create: [], update: [], archive: [] });
  });

  it('changes/archive-branch-deleted (L7): a branch whose ref no longer exists is archived as deleted', () => {
    const live = record({ id: 4, ref: 'branch:feature/cart', head: A });
    const plan = reconcile([live], [], discovered({ localBranches: ['main'] }), NOW);
    expect(plan.archive).toEqual([{ id: 4, reason: 'deleted' }]);
  });

  it('changes/archive-branch-merged (L7): a branch whose tip is contained in the base is archived as merged', () => {
    const live = record({ id: 4, ref: 'branch:feature/cart', head: A });
    const plan = reconcile([live], [], discovered({ localBranches: ['main', 'feature/cart'] }), NOW);
    expect(plan.archive).toEqual([{ id: 4, reason: 'merged' }]);
  });

  it('changes/archive-draft-clean (L7, Q4): a Draft whose working tree became clean is archived as clean', () => {
    const live = record({ id: 6, kind: 'draft', ref: 'draft:.', head: BASE(), dirty: true, worktreePath: REPO });
    const plan = reconcile([live], [], discovered(), NOW);
    expect(plan.archive).toEqual([{ id: 6, reason: 'clean' }]);
  });

  it('changes/archive-draft-clean (L7, Q4): a Draft whose changes folded into a branch is archived as clean', () => {
    const live = record({ id: 6, kind: 'draft', ref: 'draft:.', head: BASE(), dirty: true, worktreePath: REPO });
    const plan = reconcile(
      [live],
      [],
      discovered({
        worktrees: [worktree({ head: A, branch: 'feature/cart', dirty: true })],
        branches: [branch('feature/cart', A)],
      }),
      NOW,
    );
    expect(plan.archive).toEqual([{ id: 6, reason: 'clean' }]);
    expect(plan.create).toEqual([expect.objectContaining({ ref: 'branch:feature/cart', dirty: true })]);
  });

  it('changes/squash-merged-not-recreated (L7, Q4): an archived merged change with the same (ref, head) is not recreated', () => {
    const archived = record({ id: 8, ref: 'branch:feature/cart', head: A, archivedAt: '2026-03-09T00:00:00.000Z', archiveReason: 'merged' });
    const plan = reconcile([], [archived], discovered({ branches: [branch('feature/cart', A)] }), NOW);
    expect(plan.create).toEqual([]);
  });

  it('changes/squash-merged-not-recreated (L7, Q4): a new commit on that branch makes it reappear as a new change', () => {
    const archived = record({ id: 8, ref: 'branch:feature/cart', head: A, archivedAt: '2026-03-09T00:00:00.000Z', archiveReason: 'merged' });
    const plan = reconcile([], [archived], discovered({ branches: [branch('feature/cart', C)] }), NOW);
    expect(plan.create).toEqual([expect.objectContaining({ ref: 'branch:feature/cart', head: C, reviewState: 'unreviewed' })]);
  });

  it('changes/squash-merged-not-recreated (L7, Q4): the local branch of a PR squash-merged on GitHub does not come back', () => {
    const livePr = record({ id: 3, kind: 'pr', ref: 'pr:12', prNumber: 12, head: B });
    const plan = reconcile(
      [livePr],
      [],
      discovered({
        worktrees: [worktree({ head: B, branch: 'feature/pr-12' })],
        branches: [branch('feature/pr-12', B)],
        prs: { available: true, open: [], states: { 12: 'MERGED' } },
      }),
      NOW,
    );
    expect(plan.archive).toEqual([{ id: 3, reason: 'merged' }]);
    expect(plan.create).toEqual([]);
  });

  it('a closed PR does not come back through its branch while the head stays the same', () => {
    const archived = record({ id: 3, kind: 'pr', ref: 'pr:12', prNumber: 12, head: B, archivedAt: '2026-03-01T00:00:00.000Z', archiveReason: 'closed' });
    const plan = reconcile([], [archived], discovered({ branches: [branch('feature/pr-12', B)] }), NOW);
    expect(plan.create).toEqual([]);
  });

  it('uncommitted changes on a squash-merged branch become a Draft', () => {
    const archived = record({ id: 8, ref: 'branch:feature/cart', head: A, archivedAt: '2026-03-09T00:00:00.000Z', archiveReason: 'merged' });
    const plan = reconcile(
      [],
      [archived],
      discovered({ worktrees: [worktree({ head: A, branch: 'feature/cart', dirty: true })], branches: [branch('feature/cart', A)] }),
      NOW,
    );
    expect(plan.create).toEqual([expect.objectContaining({ kind: 'draft', title: 'Uncommitted changes on feature/cart' })]);
  });

  it('a deleted branch recreated at the same head comes back as a new change', () => {
    const archived = record({ id: 8, ref: 'branch:feature/cart', head: A, archivedAt: '2026-03-09T00:00:00.000Z', archiveReason: 'deleted' });
    const plan = reconcile([], [archived], discovered({ branches: [branch('feature/cart', A)] }), NOW);
    expect(plan.create).toHaveLength(1);
  });
});

describe('reviewAfterSnapshot (ADR-019, Q5)', () => {
  it('changes/approved-reset-on-content (Q5): approved + a snapshot with different content goes back to unreviewed', () => {
    const live = record({ id: 5, reviewState: 'approved', dirty: true });
    expect(reviewAfterSnapshot(live, 'replaced', NOW)).toEqual({
      id: 5,
      reviewState: 'unreviewed',
      lastEventType: 'collect',
      lastEventAt: NOW_ISO,
    });
  });

  it('an identical snapshot changes nothing', () => {
    expect(reviewAfterSnapshot(record({ reviewState: 'approved', dirty: true }), 'unchanged', NOW)).toBeNull();
  });

  it('new content on a clean change resets approved without a collect event', () => {
    const live = record({ id: 5, reviewState: 'approved' });
    expect(reviewAfterSnapshot(live, 'created', NOW)).toEqual({ id: 5, reviewState: 'unreviewed' });
  });

  it('new content on an in-review change keeps in-review and records the collect event when dirty', () => {
    const live = record({ id: 5, reviewState: 'in-review', dirty: true });
    expect(reviewAfterSnapshot(live, 'replaced', NOW)).toEqual({ id: 5, lastEventType: 'collect', lastEventAt: NOW_ISO });
  });

  it('new content on an unreviewed clean change needs no update', () => {
    expect(reviewAfterSnapshot(record({ reviewState: 'unreviewed' }), 'created', NOW)).toBeNull();
  });
});

function BASE(): string {
  return sha('ba5e');
}
