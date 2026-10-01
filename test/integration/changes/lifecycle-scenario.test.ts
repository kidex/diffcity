// End-to-end lifecycle of one change on a real temp repo (SPEC.md section 3a
// L1-L7, ADR-019 with the PO clarifications of 2026-10-01): a sequence of
// collections, each `collectSources` + `reconcile`, applied to an in-memory
// store. gh is a fake runner; the real gh is never called.

import { realpath } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isArchiveViewable } from '../../../src/core/changes/archive.js';
import { identifyRepo } from '../../../src/core/changes/identity.js';
import { reconcile } from '../../../src/core/changes/reconcile.js';
import { GH_PR_LIST_ARGS, collectSources, detectBase, listOpenPrs } from '../../../src/core/changes/sources.js';
import type { ChangePlan } from '../../../src/core/changes/types.js';
import { MemoryChangeStore } from '../../helpers/change-store.js';
import { fakeRunner, isolateGitConfig, type RecordedCall } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const DAY_MS = 86_400_000;
const START = new Date('2026-02-01T09:00:00.000Z');
/** Committer dates of the helper's commits: 2026-01-01T00:00Z plus one minute per commit. */
const commitAt = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

type GhMode = { mode: 'down' } | { mode: 'up'; open: unknown[]; states?: Record<number, string> };

/** A fake gh whose answers the scenario switches step by step. */
function fakeGh(): { set(mode: GhMode): void; calls: RecordedCall[]; runner: ReturnType<typeof fakeRunner>['runner'] } {
  let current: GhMode = { mode: 'down' };
  const { runner, calls } = fakeRunner((call) => {
    if (call.file !== 'gh') throw new Error(`unexpected command: ${call.file}`);
    if (current.mode === 'down') throw new Error('gh: could not connect to api.github.com');
    if (call.args.join(' ') === GH_PR_LIST_ARGS.join(' ')) return JSON.stringify(current.open);
    if (call.args[0] === 'pr' && call.args[1] === 'view') {
      const state = current.states?.[Number(call.args[2])];
      if (state === undefined) throw new Error('no pull requests found');
      return JSON.stringify({ state });
    }
    // `gh repo view` for the default branch: never needed here, main exists.
    throw new Error(`unexpected gh call: ${call.args.join(' ')}`);
  });
  return { set: (mode) => (current = mode), calls, runner };
}

describe('change lifecycle on a real repo (3a L1-L7, ADR-019)', () => {
  it('Draft -> Branch -> PR -> gh down -> merged -> new commit -> deleted -> out of the 90-day view', async () => {
    const repo: TempRepo = await createRepo({
      name: 'sample-garden',
      files: { 'src/plants.ts': 'export const plants: string[] = [];\n', 'README.md': '# sample-garden\n' },
    });
    try {
      const dir = await realpath(repo.dir);
      const initial = await repo.head();
      const gh = fakeGh();
      const store = new MemoryChangeStore();
      let now = START;

      /** One collection: gh pr list through the fake, sources, reconcile, apply. */
      const collect = async (): Promise<ChangePlan> => {
        const identity = await identifyRepo(repo.dir);
        const base = await detectBase(identity, { runner: gh.runner });
        const live = store.live();
        const openPrs = await listOpenPrs(identity.path, gh.runner);
        const discovered = await collectSources(identity, {
          base,
          openPrs,
          livePrNumbers: live.flatMap((change) => (change.prNumber === null ? [] : [change.prNumber])),
          runner: gh.runner,
        });
        const plan = reconcile(live, store.archived(), discovered, now);
        store.apply(plan, now);
        return plan;
      };
      const tick = (): void => {
        now = new Date(now.getTime() + 60_000);
      };

      // a. On main with a dirty tree: one Draft (L1).
      await repo.write({ 'README.md': '# sample-garden\n\nWatering notes.\n' });
      expect(await collect()).toEqual({
        create: [
          {
            kind: 'draft',
            ref: 'draft:.',
            prNumber: null,
            head: initial,
            headAvailable: true,
            dirty: true,
            worktreePath: dir,
            base: 'main',
            title: 'Uncommitted changes on main',
            ahead: 0,
            behind: 0,
            reviewState: 'unreviewed',
            lastEventType: 'commit',
            lastEventAt: commitAt(0),
          },
        ],
        update: [],
        archive: [],
      });
      expect(store.live().map((change) => [change.id, change.kind])).toEqual([[1, 'draft']]);

      // b. feat-a with 2 commits, checked out and dirty: one Branch with the uncommitted
      //    changes folded in, no separate Draft (L2, Q2).
      tick();
      await repo.branch('feat-a');
      await repo.commit('add seed catalogue', { 'src/seeds.ts': 'export const seeds = 0;\n' });
      const featA = await repo.commit('count seeds per bed', { 'src/seeds.ts': 'export const seeds = 12;\n' });
      await repo.write({ 'src/plants.ts': "export const plants: string[] = ['fern'];\n" });
      expect(await collect()).toEqual({
        create: [
          {
            kind: 'branch',
            ref: 'branch:feat-a',
            prNumber: null,
            head: featA,
            headAvailable: true,
            dirty: true,
            worktreePath: dir,
            base: 'main',
            title: 'add seed catalogue',
            ahead: 2,
            behind: 0,
            reviewState: 'unreviewed',
            lastEventType: 'commit',
            lastEventAt: commitAt(2),
          },
        ],
        update: [],
        archive: [{ id: 1, reason: 'clean' }],
      });
      expect(store.live().map((change) => [change.id, change.kind, change.ref])).toEqual([[2, 'branch', 'branch:feat-a']]);

      // c. gh lists PR #3 from feat-a at the same head: the Branch becomes PR #3, same identity (L3, L4).
      tick();
      gh.set({
        mode: 'up',
        open: [
          {
            number: 3,
            title: 'Seed catalogue',
            headRefName: 'feat-a',
            headRefOid: featA,
            baseRefName: 'main',
            isCrossRepository: false,
          },
        ],
      });
      expect(await collect()).toEqual({
        create: [],
        update: [{ id: 2, kind: 'pr', ref: 'pr:3', prNumber: 3, title: 'Seed catalogue' }],
        archive: [],
      });
      expect(store.live()).toEqual([
        expect.objectContaining({
          id: 2,
          kind: 'pr',
          ref: 'pr:3',
          prNumber: 3,
          head: featA,
          dirty: true,
          worktreePath: dir,
          ahead: 2,
          behind: 0,
          lastEventType: 'commit',
          lastEventAt: commitAt(2),
        }),
      ]);

      // d. gh goes down: PR #3 is kept and feat-a is not duplicated (L7, clarification 3).
      tick();
      gh.set({ mode: 'down' });
      const callsBeforeDown = gh.calls.length;
      expect(await collect()).toEqual({ create: [], update: [], archive: [] });
      expect(store.live().map((change) => [change.id, change.ref])).toEqual([[2, 'pr:3']]);
      // Only the failed `gh pr list`: no `gh pr view` while gh is unavailable.
      expect(gh.calls.slice(callsBeforeDown).map((call) => call.args.slice(0, 2).join(' '))).toEqual(['pr list']);

      // e. gh reports PR #3 MERGED: archived as merged; feat-a (same head) is not recreated
      //    as a Branch (L7, clarification 2). The dirty tree, with no change left to fold into, is a Draft.
      tick();
      gh.set({ mode: 'up', open: [], states: { 3: 'MERGED' } });
      expect(await collect()).toEqual({
        create: [
          {
            kind: 'draft',
            ref: 'draft:.',
            prNumber: null,
            head: featA,
            headAvailable: true,
            dirty: true,
            worktreePath: dir,
            base: 'main',
            title: 'Uncommitted changes on feat-a',
            ahead: 2,
            behind: 0,
            reviewState: 'unreviewed',
            lastEventType: 'commit',
            lastEventAt: commitAt(2),
          },
        ],
        update: [],
        archive: [{ id: 2, reason: 'merged' }],
      });
      expect(store.get(2)).toMatchObject({ archivedAt: now.toISOString(), archiveReason: 'merged' });
      expect(store.live().some((change) => change.ref === 'branch:feat-a')).toBe(false);
      // A second collection at the same head still does not bring feat-a back.
      tick();
      expect(await collect()).toEqual({ create: [], update: [], archive: [] });

      // f. A new commit on feat-a (the uncommitted changes, now committed): it comes back as a new Branch.
      tick();
      const featA2 = await repo.commit('plant the first fern');
      expect(await repo.status()).toBe('');
      expect(await collect()).toEqual({
        create: [
          {
            kind: 'branch',
            ref: 'branch:feat-a',
            prNumber: null,
            head: featA2,
            headAvailable: true,
            dirty: false,
            worktreePath: dir,
            base: 'main',
            title: 'add seed catalogue',
            ahead: 3,
            behind: 0,
            reviewState: 'unreviewed',
            lastEventType: 'commit',
            lastEventAt: commitAt(3),
          },
        ],
        update: [],
        archive: [{ id: 3, reason: 'clean' }],
      });
      expect(store.live().map((change) => [change.id, change.ref, change.head])).toEqual([[4, 'branch:feat-a', featA2]]);

      // g. Delete feat-a: archived as deleted (L7).
      tick();
      await repo.checkout('main');
      await repo.git('branch', '-D', 'feat-a');
      const deletedAt = now;
      expect(await collect()).toEqual({ create: [], update: [], archive: [{ id: 4, reason: 'deleted' }] });
      expect(store.live()).toEqual([]);
      expect(store.archived().map((change) => [change.id, change.archiveReason])).toEqual([
        [1, 'clean'],
        [2, 'merged'],
        [3, 'clean'],
        [4, 'deleted'],
      ]);

      // h. 90 days after its deletion feat-a is still viewable (the older ones, archived
      //    minutes earlier, just left the window); 91 days later none is (L7).
      const day90 = new Date(deletedAt.getTime() + 90 * DAY_MS);
      expect(store.archived().filter((change) => isArchiveViewable(change, day90)).map((change) => change.id)).toEqual([4]);
      now = new Date(deletedAt.getTime() + 91 * DAY_MS);
      expect(await collect()).toEqual({ create: [], update: [], archive: [] });
      expect(store.archived().filter((change) => isArchiveViewable(change, now))).toEqual([]);
      expect(store.live()).toEqual([]);

      // The real gh was never needed: every call went to the fake, and only for PRs.
      expect(gh.calls.every((call) => call.file === 'gh' && call.args[0] === 'pr')).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 120_000);
});
