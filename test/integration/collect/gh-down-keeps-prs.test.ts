// collect/gh-down-keeps-prs (SPEC.md section 3a L3, C5; ADR-019, ADR-020): a PR
// the daemon already knows stays live, with its snapshot, when gh stops working
// later in the daemon's lifetime: `gh pr list` exiting non-zero while the
// cached probe still says gh is available, and the probe itself failing once
// its cache has expired. No PR is archived and the repo records no error.

import { describe, expect, it } from 'vitest';
import { GH_PROBE_TTL_MS } from '../../../src/daemon/collector/gh.js';
import { fakeRunner, isolateGitConfig } from '../../helpers/git-env.js';
import { cleanupAfterEach, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const START = new Date('2026-03-01T09:00:00.000Z').getTime();

/** gh that works until `down` is set, then fails every call like a non-zero exit. */
function flakyGh(prs: () => unknown[]) {
  const state = { down: false };
  const fake = fakeRunner((call) => {
    if (state.down) throw Object.assign(new Error(`gh ${call.args.join(' ')} exited with code 1`), { code: 1 });
    if (call.args[0] === '--version') return 'gh version 2.0.0\n';
    if (call.args[0] === 'auth') return '';
    if (call.args[0] === 'pr' && call.args[1] === 'list') return JSON.stringify(prs());
    throw new Error(`unexpected gh call: ${call.args.join(' ')}`);
  });
  const count = (sub: string): number => fake.calls.filter((call) => call.args[0] === sub).length;
  return { runner: fake.runner, state, count };
}

describe('collect/gh-down-keeps-prs (L3, C5)', () => {
  it('gh failing after the PRs were listed keeps the PR live, unarchived, with its snapshot, and no repo error', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/pastry');
    const tip = await repo.commit('add the pastry', { 'src/pastry/tart.ts': 'export const tart = 1;\n' });
    await repo.checkout('main');
    const gh = flakyGh(() => [
      { number: 31, title: 'Pastry counter', headRefName: 'feature/pastry', headRefOid: tip, baseRefName: 'main', isCrossRepository: false },
    ]);
    let clock = START;
    const test = await startTestDaemon({ gh: gh.runner, now: () => new Date(clock) });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    const repoId = response.repo.id;
    await test.idle();
    const db = test.collection.db();
    const collector = test.collection.collector();
    const before = db.changes.listLiveSummaries(repoId);
    expect(before).toEqual([expect.objectContaining({ kind: 'pr', prNumber: 31, title: 'Pastry counter', head: tip })]);
    expect(before[0]?.stats).not.toBeNull();

    // gh goes down: the probe is still cached as available, `pr list` exits non-zero.
    gh.state.down = true;
    const listCallsBefore = gh.count('pr');
    expect(await collector.request(repoId, 'prs', 'normal')).toEqual({ ok: true });
    expect(gh.count('pr')).toBe(listCallsBefore + 1);
    expect(db.changes.listLiveSummaries(repoId)).toEqual(before);
    expect(db.changes.listArchived(repoId)).toEqual([]);
    expect(db.repos.get(repoId)?.collectError).toBeNull();

    // An hour later the probe runs again and fails too: still nothing archived.
    clock += GH_PROBE_TTL_MS + 1;
    const probesBefore = gh.count('auth');
    expect(await collector.request(repoId, 'full', 'high')).toEqual({ ok: true });
    expect(gh.count('auth')).toBe(probesBefore + 1);
    expect(db.changes.listLiveSummaries(repoId)).toEqual(before);
    expect(db.changes.listArchived(repoId)).toEqual([]);
    expect(db.repos.get(repoId)?.collectError).toBeNull();

    // gh comes back: the PR is listed again and stays the same change.
    gh.state.down = false;
    clock += GH_PROBE_TTL_MS + 1;
    expect(await collector.request(repoId, 'prs', 'normal')).toEqual({ ok: true });
    expect(db.changes.listLiveSummaries(repoId).map((change) => change.id)).toEqual(before.map((change) => change.id));
  });
});
