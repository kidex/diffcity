import { describe, expect, it } from 'vitest';
import { detectBase } from '../../../src/core/changes/sources.js';
import { identifyRepo } from '../../../src/core/changes/identity.js';
import type { CommandRunner } from '../../../src/core/git/index.js';
import { fakeRunner, ghForbidden, isolateGitConfig } from '../../helpers/git-env.js';
import type { TempRepo } from '../../helpers/repo.js';
import { checkoutRepo, cleanupRepos, collect, sampleShop, stored } from './collect-helper.js';

isolateGitConfig();
cleanupRepos();

describe('branches (L2, L6)', () => {
  it('changes/branch-ahead (L2) + changes/ahead-behind (L6) + changes/title-first-commit (L6)', async () => {
    const { repo, tip } = await checkoutRepo();
    const { plan } = await collect(repo);
    expect(plan.create).toEqual([
      {
        kind: 'branch',
        ref: 'branch:feature/checkout',
        prNumber: null,
        head: tip,
        headAvailable: true,
        dirty: false,
        worktreePath: null,
        base: 'main',
        title: 'add checkout total',
        ahead: 2,
        behind: 1,
        reviewState: 'unreviewed',
        lastEventType: 'commit',
        // The third commit of the helper's clock: 2026-01-01T00:00Z + 2 minutes.
        lastEventAt: '2026-01-01T00:02:00.000Z',
      },
    ]);
  });

  it('changes/branch-not-ahead-ignored (L2): a branch with no commits ahead produces nothing', async () => {
    const repo = await sampleShop();
    await repo.git('branch', 'feature/idle');
    const { discovered, plan } = await collect(repo);
    expect(discovered.branches).toEqual([]);
    expect(discovered.localBranches.sort()).toEqual(['feature/idle', 'main']);
    expect(plan.create).toEqual([]);
  });

  it('changes/base-excluded (L2): the base never appears as a change, even checked out and ahead of others', async () => {
    const { repo } = await checkoutRepo();
    const { discovered, plan } = await collect(repo);
    expect(discovered.branches.map((branch) => branch.name)).toEqual(['feature/checkout']);
    expect(plan.create.map((change) => change.ref)).not.toContain('branch:main');
  });

  it('changes/two-branches-same-head (L4): two branches on the same head are one change', async () => {
    const { repo, tip } = await checkoutRepo();
    await repo.git('branch', 'feature/alias', tip);
    const { plan } = await collect(repo);
    expect(plan.create.map((change) => change.ref)).toEqual(['branch:feature/alias']);
  });

  it('changes/last-event-commit-date (L6): the last event is a commit at the committer date of the head', async () => {
    const { repo } = await checkoutRepo();
    const first = await collect(repo);
    await repo.checkout('feature/checkout');
    const newTip = await repo.commit('checkout tax', { 'src/tax.ts': 'export const tax = 0;\n' });
    const second = await collect(repo, { live: stored(first.plan) });
    expect(second.plan.update).toMatchObject([
      { id: 1, head: newTip, lastEventAt: '2026-01-01T00:04:00.000Z', ahead: 3 },
    ]);
  });
});

describe('archive with real refs (L7)', () => {
  it('changes/archive-branch-deleted (L7): a deleted branch is archived as deleted', async () => {
    const { repo } = await checkoutRepo();
    const first = await collect(repo);
    await repo.git('branch', '-D', 'feature/checkout');
    const { plan } = await collect(repo, { live: stored(first.plan) });
    expect(plan.archive).toEqual([{ id: 1, reason: 'deleted' }]);
  });

  it('changes/archive-branch-merged (L7): a branch contained in the base is archived as merged', async () => {
    const { repo } = await checkoutRepo();
    const first = await collect(repo);
    await repo.git('merge', '--quiet', '--no-edit', 'feature/checkout');
    const { discovered, plan } = await collect(repo, { live: stored(first.plan) });
    expect(discovered.localBranches).toContain('feature/checkout');
    expect(plan.archive).toEqual([{ id: 1, reason: 'merged' }]);
  });
});

describe('base detection (L5)', () => {
  it('changes/base-detection-three-repos (L5): main, then master, then the gh default branch', async () => {
    const onMain = await sampleShop({ initialBranch: 'main' });
    const onMaster = await sampleShop({ initialBranch: 'master' });
    const onTrunk = await sampleShop({ initialBranch: 'trunk' });
    const gh = fakeRunner(() => '{"defaultBranchRef":{"name":"trunk"}}');
    const base = async (repo: TempRepo, runner: CommandRunner): Promise<string> =>
      (await detectBase(await identifyRepo(repo.dir), { runner })).name;
    expect(await base(onMain, ghForbidden().runner)).toBe('main');
    expect(await base(onMaster, ghForbidden().runner)).toBe('master');
    expect(await base(onTrunk, gh.runner)).toBe('trunk');
  });

  it('the base from diffcity.config.js overrides the detection (L5)', async () => {
    const repo = await sampleShop();
    await repo.git('branch', 'develop');
    expect((await detectBase(await identifyRepo(repo.dir), { config: 'develop', runner: ghForbidden().runner })).name).toBe('develop');
  });

  it('a Draft and a Branch carry the detected base name', async () => {
    const repo = await sampleShop({ initialBranch: 'master' });
    await repo.branch('feature/coupon');
    await repo.commit('add coupon', { 'src/coupon.ts': 'export const coupon = 1;\n' });
    await repo.checkout('master');
    await repo.write({ 'README.md': '# sample-shop (draft)\n' });
    const { plan } = await collect(repo);
    expect(plan.create.map((change) => [change.kind, change.base, change.title])).toEqual([
      ['branch', 'master', 'add coupon'],
      ['draft', 'master', 'Uncommitted changes on master'],
    ]);
  });
});
