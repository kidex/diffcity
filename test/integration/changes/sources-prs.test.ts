import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { identifyRepo } from '../../../src/core/changes/identity.js';
import {
  GH_PR_LIST_ARGS,
  GH_PR_TIMEOUT_MS,
  collectSources,
  detectBase,
  listOpenPrs,
  prState,
} from '../../../src/core/changes/sources.js';
import type { CommandRunner } from '../../../src/core/git/index.js';
import { fakeRunner, ghMissing, isolateGitConfig, type RecordedCall } from '../../helpers/git-env.js';
import { NOT_LOCAL, NOW, checkoutRepo, cleanupRepos, collect, ghPr, remotePr, sampleShop, stored } from './collect-helper.js';

isolateGitConfig();
cleanupRepos();

const execFileAsync = promisify(execFile);

/** Exit code of `git cat-file -e <oid>^{commit}` in `dir`, with lazy fetching off so the check itself fetches nothing. */
async function objectExitCode(dir: string, oid: string): Promise<number> {
  try {
    await execFileAsync('git', ['cat-file', '-e', `${oid}^{commit}`], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1' },
    });
    return 0;
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1;
  }
}

describe('PRs (L3, L4, Q3)', () => {
  it('changes/pr-head-not-local (L3, Q3, ADR-024): a partial clone does not lazily fetch the PR head', async () => {
    // The origin serves any object on demand, so an unguarded `cat-file -e` in the clone would fetch the PR head.
    const origin = await sampleShop();
    await origin.git('config', 'uploadpack.allowFilter', 'true');
    await origin.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    const prHead = await origin.git('commit-tree', '-m', 'remote-only PR commit', '-p', 'HEAD', 'HEAD^{tree}');
    await origin.git('update-ref', 'refs/pull/5/head', prHead);
    const clone = join(dirname(await realpath(origin.dir)), 'sample-shop-partial');
    await origin.git('clone', '--quiet', '--filter=blob:none', '--no-local', `file://${await realpath(origin.dir)}`, clone);
    expect(await objectExitCode(clone, prHead)).not.toBe(0);

    const identity = await identifyRepo(clone);
    const base = await detectBase(identity, { runner: fakeRunner(() => '{}').runner });
    const discovered = await collectSources(identity, { base, openPrs: [ghPr(5, prHead)], runner: fakeRunner(() => '{}').runner });

    expect(discovered.prs).toMatchObject({ available: true, open: [{ number: 5, headAvailable: false, ahead: null, behind: null }] });
    expect(await objectExitCode(clone, prHead)).not.toBe(0);
  });

  it('changes/pr-from-gh (L3) + changes/title-pr (L6): an open PR from gh is PR #N with its title', async () => {
    const { repo, tip } = await checkoutRepo();
    await repo.git('branch', '-D', 'feature/checkout');
    await repo.git('update-ref', 'refs/remotes/origin/feature/checkout', tip);
    const gh = fakeRunner(() => JSON.stringify([ghPr(7, tip)]));
    const identity = await identifyRepo(repo.dir);
    const openPrs = await listOpenPrs(identity.path, gh.runner);
    const { plan } = await collect(repo, { openPrs, runner: gh.runner });
    expect(gh.calls).toEqual([{ file: 'gh', args: GH_PR_LIST_ARGS, cwd: identity.path, timeoutMs: GH_PR_TIMEOUT_MS }]);
    expect(plan.create).toEqual([
      expect.objectContaining({
        kind: 'pr',
        ref: 'pr:7',
        prNumber: 7,
        head: tip,
        headAvailable: true,
        title: 'Checkout flow 7',
        ahead: 2,
        behind: 1,
        base: 'main',
      }),
    ]);
  });

  it('changes/pr-head-not-local (L3, Q3): a PR whose head is not local has no counters and nothing is fetched', async () => {
    const repo = await sampleShop();
    const refsBefore = await repo.git('for-each-ref');
    const { plan } = await collect(repo, { openPrs: [ghPr(9, NOT_LOCAL, { title: 'Remote only' })] });
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'pr', ref: 'pr:9', head: NOT_LOCAL, headAvailable: false, ahead: null, behind: null, title: 'Remote only' }),
    ]);
    expect(await repo.git('for-each-ref')).toBe(refsBefore);
    await expect(repo.git('cat-file', '-e', `${NOT_LOCAL}^{commit}`)).rejects.toThrow();
  });

  it('changes/branch-with-pr-same-head-once (L4): a branch with an open PR at the same head appears once, as PR', async () => {
    const { repo, tip } = await checkoutRepo();
    await repo.checkout('feature/checkout');
    const { plan } = await collect(repo, { openPrs: [ghPr(7, tip)] });
    expect(plan.create).toEqual([
      expect.objectContaining({ kind: 'pr', ref: 'pr:7', head: tip, worktreePath: await realpath(repo.dir) }),
    ]);
  });

  it('changes/branch-ahead-of-pr-twice (L4): unpushed commits make a Branch next to the PR', async () => {
    const { repo, tip } = await checkoutRepo();
    await repo.checkout('feature/checkout');
    const local = await repo.commit('unpushed tweak', { 'src/checkout.ts': 'export const total = 3;\n' });
    const { plan } = await collect(repo, { openPrs: [ghPr(7, tip)] });
    expect(plan.create.map((change) => [change.kind, change.ref, change.head])).toEqual([
      ['pr', 'pr:7', tip],
      ['branch', 'branch:feature/checkout', local],
    ]);
  });

  it('changes/identity-branch-gets-pr (L6): the Branch change becomes the PR, same id', async () => {
    const { repo, tip } = await checkoutRepo();
    const first = await collect(repo);
    const live = stored(first.plan).map((change) => ({ ...change, reviewState: 'in-review' as const }));
    const { plan } = await collect(repo, { live, openPrs: [ghPr(7, tip)] });
    expect(plan.create).toEqual([]);
    expect(plan.update).toMatchObject([{ id: 1, fields: { kind: 'pr', ref: 'pr:7', prNumber: 7, reviewState: 'in-review' } }]);
  });

  it('changes/archive-pr-merged (L7): a live PR no longer open is checked with gh pr view and archived', async () => {
    const repo = await sampleShop();
    const pr = remotePr(9);
    const gh = fakeRunner((call: RecordedCall) => (call.args[1] === 'view' ? '{"state":"MERGED"}' : '[]'));
    const { plan } = await collect(repo, { live: [pr], openPrs: [], runner: gh.runner });
    expect(gh.calls.map((call) => call.args)).toContainEqual(['pr', 'view', '9', '--json', 'state']);
    expect(plan.archive).toEqual([{ id: 3, reason: 'merged', at: NOW.toISOString() }]);
  });
});

describe('gh calls (L3, C5)', () => {
  it('listOpenPrs returns null when gh is missing', async () => {
    expect(await listOpenPrs('/work/sample-shop', ghMissing().runner)).toBeNull();
  });

  it('listOpenPrs returns null on unreadable output and skips malformed entries', async () => {
    expect(await listOpenPrs('/work/sample-shop', fakeRunner(() => 'not json').runner)).toBeNull();
    expect(await listOpenPrs('/work/sample-shop', fakeRunner(() => '{"number":1}').runner)).toBeNull();
    const mixed = JSON.stringify([ghPr(1, NOT_LOCAL), { number: 2, title: 'no head' }, ghPr(3, 'not-a-sha')]);
    expect((await listOpenPrs('/work/sample-shop', fakeRunner(() => mixed).runner))?.map((pr) => pr.number)).toEqual([1]);
  });

  it('prState reads MERGED, CLOSED and OPEN, and null otherwise', async () => {
    const answer = (state: string): CommandRunner => fakeRunner(() => JSON.stringify({ state })).runner;
    expect(await prState('/work/sample-shop', 4, answer('MERGED'))).toBe('MERGED');
    expect(await prState('/work/sample-shop', 4, answer('CLOSED'))).toBe('CLOSED');
    expect(await prState('/work/sample-shop', 4, answer('OPEN'))).toBe('OPEN');
    expect(await prState('/work/sample-shop', 4, answer('DRAFT'))).toBeNull();
    expect(await prState('/work/sample-shop', 4, ghMissing().runner)).toBeNull();
  });

  it('changes/no-archive-when-gh-down (L7): without gh the live PR is neither archived nor queried', async () => {
    const repo = await sampleShop();
    const pr = remotePr(9);
    const gh = ghMissing();
    const openPrs = await listOpenPrs(repo.dir, gh.runner);
    const { discovered, plan } = await collect(repo, { live: [pr], openPrs, runner: gh.runner });
    expect(discovered.prs).toEqual({ available: false });
    expect(plan).toEqual({ create: [], update: [], archive: [] });
    expect(gh.calls).toHaveLength(1);
  });
});
