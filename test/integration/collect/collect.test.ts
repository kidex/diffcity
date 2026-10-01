// Collection in the daemon (SPEC.md section 3a C2, C3, C5, L6; ADR-019, ADR-020,
// ADR-021): the track and register socket handlers, the collector's order of
// work, its errors and its SSE signals, in an in-process daemon with the inline
// snapshot runner and a stubbed gh.

import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sendRequest } from '../../../src/daemon/client.js';
import { GH_TIMEOUT_PAUSE_MS } from '../../../src/daemon/collector/gh.js';
import { getRuntime } from '../../../src/daemon/runtime.js';
import { fakeRunner, isolateGitConfig } from '../../helpers/git-env.js';
import { waitFor } from '../../helpers/daemon.js';
import { cleanupAfterEach, ghNotInstalled, ghWithPrs, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const NOW = new Date('2026-02-01T00:00:00.000Z');
const fixedNow = (): Date => NOW;

/** main + feature/checkout (2 commits ahead, 1 behind) + an untracked file on main. */
async function shopWithBranchAndDraft() {
  const repo = await sampleRepo();
  await repo.branch('feature/checkout');
  await repo.commit('sum the cart', {
    'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n',
  });
  const tip = await repo.commit('add a session token', { 'src/session/token.ts': 'export const token = "";\n' });
  await repo.checkout('main');
  await repo.commit('update the readme', { 'README.md': '# sample-shop\n\nA shop.\n' });
  await repo.write({ 'src/cart/line.ts': 'export const line = 1;\n' });
  return { repo, tip };
}

describe('collect/track-registers-and-collects (C2)', () => {
  it('registers a missing repo, answers before collecting, then collects every change with a snapshot', async () => {
    const { repo } = await shopWithBranchAndDraft();
    // gh holds the first collection at its PR refresh until the test lets it go.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gh = ghWithPrs(() => []);
    const blockingGh: typeof gh.runner = async (file, args, options) => {
      if (args[0] === 'pr') await held;
      return gh.runner(file, args, options);
    };
    const test = await startTestDaemon({ gh: blockingGh, now: fixedNow });

    const response = await test.track(join(repo.dir, 'src'));
    expect(response).toEqual({ ok: true, repo: { id: expect.any(Number) as number, name: 'sample-shop' } });
    if (!response.ok) throw new Error(response.error);
    const db = test.collection.db();
    const stored = db.repos.get(response.repo.id);
    expect(stored).toMatchObject({ name: 'sample-shop', active: true, collectError: null });
    // The response came first: nothing is collected yet.
    expect(db.changes.listLive(response.repo.id)).toEqual([]);
    expect(test.collection.collector().isCollecting(response.repo.id)).toBe(true);
    // The API's RepoSummary reads the same flag (DC-31).
    if (stored === null) throw new Error('repo not stored');
    expect(getRuntime(test.daemon.context)(stored)).toEqual({ collecting: true, watch: 'full' });

    release();
    await test.idle();
    expect(getRuntime(test.daemon.context)(stored).collecting).toBe(false);
    const changes = db.changes.listLiveSummaries(response.repo.id);
    expect(changes.map((change) => change.ref).sort()).toEqual(['branch:feature/checkout', 'draft:.']);
    for (const change of changes) expect(change.stats).not.toBeNull();
    const events = db.events.listForRepo(response.repo.id);
    expect(events.filter((event) => event.type === 'commit')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'collect')).toHaveLength(2);
  });

  it('a directory outside any repo gets the protocol error and registers nothing', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const outside = join(test.home.root, 'plain');
    await mkdir(outside);
    expect(await test.track(outside)).toEqual({ ok: false, error: `not a git repository: ${outside}` });
    expect(test.collection.db().repos.list()).toEqual([]);
  });

  it('track reactivates an inactive repo and moves lastSeenAt forward', async () => {
    const repo = await sampleRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const registered = await test.register([repo.dir]);
    expect(registered).toEqual({ ok: true, registered: 1, known: 0 });
    await test.idle();
    const [before] = test.collection.db().repos.list();
    expect(before?.active).toBe(false);
    await test.track(repo.dir, false, '2030-01-01T00:00:00.000Z');
    const after = test.collection.db().repos.get(before?.id ?? 0);
    expect(after).toMatchObject({ active: true, lastSeenAt: '2030-01-01T00:00:00.000Z' });
    await test.idle();
  });
});

describe('collect/change-record-fields (L6)', () => {
  it('each change carries title, ahead/behind, files and symbols by status, verdicts, review state and last event', async () => {
    const { repo, tip } = await shopWithBranchAndDraft();
    const test = await startTestDaemon({ gh: ghNotInstalled(), now: fixedNow });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const changes = test.collection.db().changes.listLiveSummaries(response.repo.id);
    const branch = changes.find((change) => change.kind === 'branch');
    const draft = changes.find((change) => change.kind === 'draft');

    expect(branch).toMatchObject({
      ref: 'branch:feature/checkout',
      prNumber: null,
      head: tip,
      headAvailable: true,
      dirty: false,
      base: 'main',
      title: 'sum the cart',
      ahead: 2,
      behind: 1,
      reviewState: 'unreviewed',
      agentUnreviewed: false,
      lastEvent: { type: 'commit', at: '2026-01-01T00:02:00.000Z' },
      archivedAt: null,
      stats: {
        touchedFiles: 2,
        symbolsByStatus: { add: 1, mod: 1, sig: 0, del: 0, same: 0 },
        filesByVerdict: { eyes: 1, risky: 0, spec: 0, ok: 1, same: 0 },
        tier1Files: ['src/session/token.ts'],
      },
    });
    expect(draft).toMatchObject({
      ref: 'draft:.',
      head: await repo.head(),
      dirty: true,
      base: 'main',
      title: 'Uncommitted changes on main',
      ahead: 0,
      behind: 0,
      reviewState: 'unreviewed',
      agentUnreviewed: false,
      // A new snapshot of a dirty change is a `collect` event (ADR-019).
      lastEvent: { type: 'collect', at: NOW.toISOString() },
      stats: { touchedFiles: 1, tier1Files: [] },
    });
    expect(draft?.stats?.symbolsByStatus.add).toBe(1);
  });
});

describe('collect/track-agent-marks (C3)', () => {
  it('track --agent marks the working tree change "agent worked, not reviewed" and writes an agent event', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/agent');
    await repo.commit('agent work', { 'src/cart/total.ts': 'export const total = 2;\n' });
    await repo.write({ 'src/cart/line.ts': 'export const line = 1;\n' });
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const first = await test.track(repo.dir);
    if (!first.ok) throw new Error(first.error);
    await test.idle();
    const db = test.collection.db();
    const [change] = db.changes.listLive(first.repo.id);
    if (change === undefined) throw new Error('no change collected');
    expect(change).toMatchObject({ kind: 'branch', dirty: true });
    db.changes.applyPlan(first.repo.id, { create: [], update: [{ id: change.id, reviewState: 'approved' }], archive: [] }, new Date().toISOString());

    // The agent changed the working tree again: the agent collection stores a new
    // snapshot (a `collect` last event), and the agent mark must still come last.
    await repo.write({ 'src/cart/line.ts': 'export const line = 1;\nexport const extra = 2;\n' });
    const at = '2031-05-06T07:08:09.000Z';
    await test.track(join(repo.dir, 'src', 'cart'), true, at);
    await waitFor(() => db.events.listForRepo(first.repo.id).some((event) => event.type === 'agent'), 20_000, 'the agent event');
    await test.idle();
    expect(db.changes.getSummary(change.id)).toMatchObject({
      reviewState: 'unreviewed',
      agentUnreviewed: true,
      lastEvent: { type: 'agent', at },
    });
    const agentEvents = db.events.listForRepo(first.repo.id).filter((event) => event.type === 'agent');
    expect(db.events.listForRepo(first.repo.id).filter((event) => event.type === 'collect' && event.changeId === change.id)).toHaveLength(2);
    expect(agentEvents).toEqual([expect.objectContaining({ changeId: change.id, at, payload: { worktree: await realpath(repo.dir) } })]);
  });

  it('with no change in the working tree, the agent event is repo-level', async () => {
    const repo = await sampleRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir, true, '2031-05-06T07:08:09.000Z');
    if (!response.ok) throw new Error(response.error);
    const db = test.collection.db();
    await waitFor(() => db.events.listForRepo(response.repo.id).some((event) => event.type === 'agent'), 20_000, 'the agent event');
    expect(db.changes.listLive(response.repo.id)).toEqual([]);
    expect(db.events.listForRepo(response.repo.id)).toEqual([
      expect.objectContaining({ changeId: null, type: 'agent', at: '2031-05-06T07:08:09.000Z' }),
    ]);
  });
});

describe('collect/first-collect-refreshes-prs (C5)', () => {
  it('the first collection lists the PRs; later ones use the cache until it is 15 minutes old or a `prs` request', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/checkout');
    const tip = await repo.commit('add the checkout', { 'src/checkout/pay.ts': 'export const pay = 1;\n' });
    await repo.checkout('main');
    const gh = ghWithPrs(() => [
      {
        number: 12,
        title: 'Checkout flow',
        headRefName: 'feature/checkout',
        headRefOid: tip,
        baseRefName: 'main',
        isCrossRepository: false,
      },
    ]);
    let clock = NOW.getTime();
    const test = await startTestDaemon({ gh: gh.runner, now: () => new Date(clock) });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const collector = test.collection.collector();
    const db = test.collection.db();
    expect(gh.prListCalls()).toBe(1);
    expect(db.changes.listLiveSummaries(response.repo.id)).toEqual([
      expect.objectContaining({ kind: 'pr', prNumber: 12, title: 'Checkout flow', head: tip }),
    ]);

    await collector.request(response.repo.id, 'refs', 'normal');
    await collector.request(response.repo.id, 'full', 'high');
    expect(gh.prListCalls()).toBe(1);
    await collector.request(response.repo.id, 'prs', 'low');
    expect(gh.prListCalls()).toBe(2);
    clock += 15 * 60 * 1000;
    await collector.request(response.repo.id, 'full', 'high');
    expect(gh.prListCalls()).toBe(3);
  });

  it('a gh pr list that times out is retried by the next collection, without waiting 15 minutes', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/checkout');
    const tip = await repo.commit('add the checkout', { 'src/checkout/pay.ts': 'export const pay = 1;\n' });
    await repo.checkout('main');
    let slow = true;
    const gh = fakeRunner((call) => {
      if (call.args[0] !== 'pr' || call.args[1] !== 'list') throw new Error(`unexpected gh call: ${call.args.join(' ')}`);
      if (slow) throw Object.assign(new Error('gh timed out'), { killed: true, signal: 'SIGTERM' });
      return JSON.stringify([
        { number: 12, title: 'Checkout flow', headRefName: 'feature/checkout', headRefOid: tip, baseRefName: 'main', isCrossRepository: false },
      ]);
    });
    const test = await startTestDaemon({ gh: gh.runner, now: fixedNow });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const db = test.collection.db();
    const branches = db.changes.listLive(response.repo.id);
    expect(branches.map((change) => change.kind)).toEqual(['branch']);
    expect(db.repos.get(response.repo.id)?.collectError).toBeNull();

    slow = false;
    expect(await test.collection.collector().request(response.repo.id, 'refs', 'normal')).toEqual({ ok: true });
    expect(gh.calls).toHaveLength(2);
    // The Branch became the PR: the same change, with its id.
    expect(db.changes.listLiveSummaries(response.repo.id)).toEqual([
      expect.objectContaining({ id: branches[0]?.id, kind: 'pr', prNumber: 12 }),
    ]);
  });

  it('a hung GitHub: after 2 timeouts in a row the repo skips gh for 5 minutes', async () => {
    const repo = await sampleRepo();
    let clock = NOW.getTime();
    const gh = fakeRunner(() => {
      throw Object.assign(new Error('gh timed out'), { killed: true, signal: 'SIGTERM' });
    });
    const test = await startTestDaemon({ gh: gh.runner, now: () => new Date(clock) });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const collector = test.collection.collector();
    expect(gh.calls).toHaveLength(1);
    // A timeout leaves the PR cache unrefreshed, so the next collection asks again...
    expect(await collector.request(response.repo.id, 'refs', 'normal')).toEqual({ ok: true });
    expect(gh.calls).toHaveLength(2);
    // ...but after the second timeout in a row gh is paused for this repo.
    expect(await collector.request(response.repo.id, 'prs', 'normal')).toEqual({ ok: true });
    expect(gh.calls).toHaveLength(2);
    clock += GH_TIMEOUT_PAUSE_MS;
    expect(await collector.request(response.repo.id, 'prs', 'normal')).toEqual({ ok: true });
    expect(gh.calls).toHaveLength(3);
    expect(test.collection.db().repos.get(response.repo.id)?.collectError).toBeNull();
  });

  it('without gh the PR step is skipped silently: no error on the repo', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/checkout');
    await repo.commit('add the checkout', { 'src/checkout/pay.ts': 'export const pay = 1;\n' });
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    expect(test.collection.db().repos.get(response.repo.id)?.collectError).toBeNull();
    expect(test.collection.db().changes.listLive(response.repo.id).map((change) => change.kind)).toEqual(['branch']);
  });
});

describe('collect/pr-base-not-local', () => {
  it('a PR whose base is not a local branch is snapshotted against origin, else the repo base', async () => {
    const repo = await sampleRepo();
    const mainTip = await repo.head();
    // `develop` exists only as a remote-tracking ref; `release/2026` exists nowhere.
    await repo.git('update-ref', 'refs/remotes/origin/develop', mainTip);
    await repo.branch('feature/checkout');
    const checkout = await repo.commit('add the checkout', { 'src/checkout/pay.ts': 'export const pay = 1;\n' });
    await repo.checkout('main');
    await repo.branch('feature/refunds');
    const refunds = await repo.commit('add refunds', { 'src/refunds.ts': 'export const refund = 0;\n' });
    await repo.checkout('main');
    const pr = (number: number, head: string, baseRefName: string) => ({
      number,
      title: `PR ${String(number)}`,
      headRefName: number === 1 ? 'feature/checkout' : 'feature/refunds',
      headRefOid: head,
      baseRefName,
      isCrossRepository: false,
    });
    const gh = ghWithPrs(() => [pr(1, checkout, 'develop'), pr(2, refunds, 'release/2026')]);
    const test = await startTestDaemon({ gh: gh.runner });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const db = test.collection.db();
    expect(db.repos.get(response.repo.id)?.collectError).toBeNull();
    const changes = db.changes.listLiveSummaries(response.repo.id);
    expect(changes.map((change) => [change.kind, change.base]).sort()).toEqual([
      ['pr', 'develop'],
      ['pr', 'release/2026'],
    ]);
    for (const change of changes) expect(change.stats?.touchedFiles).toBe(1);
  });
});

describe('collect/collect-error-recorded', () => {
  it('a failed collection is stored on the repo and sent over SSE; the daemon keeps running and recovers', async () => {
    // No main, no master and no gh: the base cannot be found.
    const repo = await sampleRepo({ initialBranch: 'trunk' });
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const db = test.collection.db();
    expect(db.repos.get(response.repo.id)?.collectError).toMatch(/no base branch found/);
    const sent = await waitFor(
      () => test.events().find((record) => record.event === 'collect' && record.data.state === 'error'),
      5000,
      'the SSE collect error',
    );
    expect(sent.data).toEqual({ repoId: response.repo.id, state: 'error', error: expect.stringMatching(/no base branch found/) as string });
    expect(await sendRequest(test.daemon.info.socket, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
    const health = await fetch(`http://127.0.0.1:${String(test.daemon.info.port)}/api/health`);
    expect(health.status).toBe(200);

    await repo.git('branch', 'main');
    expect(await test.collection.collector().request(response.repo.id, 'full', 'high')).toEqual({ ok: true });
    expect(db.repos.get(response.repo.id)?.collectError).toBeNull();
  });

  it('a repo whose directory disappeared records the error', async () => {
    const repo = await sampleRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    await rm(repo.dir, { recursive: true, force: true });
    const outcome = await test.collection.collector().request(response.repo.id, 'refs', 'normal');
    expect(outcome.ok).toBe(false);
    expect(test.collection.db().repos.get(response.repo.id)?.collectError).toMatch(/not a git repository/);
  });
});

describe('collect/register-inactive-collects-once (Q6)', () => {
  it('registers new repos as inactive and collects each new one exactly once', async () => {
    const shop = await sampleRepo();
    const orders = await sampleRepo({ name: 'order-service' });
    await orders.branch('feature/refunds');
    await orders.commit('add refunds', { 'src/refunds.ts': 'export const refund = 0;\n' });
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const plain = join(test.home.root, 'plain');
    await mkdir(plain);

    expect(await test.register([shop.dir, join(shop.dir, 'src'), orders.dir, plain])).toEqual({ ok: true, registered: 2, known: 0 });
    await test.idle();
    const repos = test.collection.db().repos.list();
    expect(repos.map((repo) => [repo.name, repo.active])).toEqual([
      ['sample-shop', false],
      ['order-service', false],
    ]);
    const started = (): number[] =>
      test
        .events()
        .filter((record) => record.event === 'collect' && record.data.state === 'started')
        .map((record) => record.data.repoId as number);
    expect(started().sort()).toEqual(repos.map((repo) => repo.id).sort());
    const orderService = repos.find((repo) => repo.name === 'order-service');
    expect(test.collection.db().changes.listLive(orderService?.id ?? 0)).toHaveLength(1);

    expect(await test.register([shop.dir, orders.dir])).toEqual({ ok: true, registered: 0, known: 2 });
    await test.idle();
    expect(started()).toHaveLength(2);
    expect(test.collection.db().repos.list().every((repo) => !repo.active)).toBe(true);
  });
});

describe('sse/events-after-collect', () => {
  it('a collection sends repo, changes, snapshot and collect, in that order', async () => {
    const { repo } = await shopWithBranchAndDraft();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    await waitFor(() => test.events().some((record) => record.event === 'collect' && record.data.state === 'done'), 5000, 'collect done');
    const names = test
      .events()
      .filter((record) => record.event !== 'hello' && record.data.repoId === response.repo.id)
      .map((record) => (record.event === 'collect' ? `collect:${String(record.data.state)}` : record.event));
    const repoAfterPlan = names.indexOf('repo', names.indexOf('collect:started'));
    const changes = names.indexOf('changes', repoAfterPlan);
    const snapshot = names.indexOf('snapshot', changes);
    const done = names.indexOf('collect:done', snapshot);
    expect([repoAfterPlan, changes, snapshot, done].every((index) => index >= 0)).toBe(true);
    expect(names.filter((name) => name === 'snapshot')).toHaveLength(2);
    expect(names.at(-1)).toBe('collect:done');
  });
});

describe('collector coalescing (ADR-021)', () => {
  it('N requests for a repo while it collects give at most 2 collections', async () => {
    const { repo } = await shopWithBranchAndDraft();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const before = test.events().filter((record) => record.event === 'collect' && record.data.state === 'started').length;
    const collector = test.collection.collector();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => collector.request(response.repo.id, i % 2 === 0 ? 'refs' : `worktree:${repo.dir}`, 'normal')),
    );
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const after = test.events().filter((record) => record.event === 'collect' && record.data.state === 'started').length;
    expect(after - before).toBeLessThanOrEqual(2);
    expect(after - before).toBeGreaterThanOrEqual(1);
  });

  it('a second collection with nothing new writes no snapshot and no event', async () => {
    const { repo } = await shopWithBranchAndDraft();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const db = test.collection.db();
    const eventsBefore = db.events.listForRepo(response.repo.id).length;
    expect(await test.collection.collector().request(response.repo.id, 'full', 'high')).toEqual({ ok: true });
    expect(db.events.listForRepo(response.repo.id)).toHaveLength(eventsBefore);
  });

  it('a new commit on a branch: commit event, new snapshot, approved goes back to unreviewed', async () => {
    const { repo } = await shopWithBranchAndDraft();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();
    const db = test.collection.db();
    const branch = db.changes.listLive(response.repo.id).find((change) => change.kind === 'branch');
    if (branch === undefined) throw new Error('no branch change');
    db.changes.applyPlan(response.repo.id, { create: [], update: [{ id: branch.id, reviewState: 'approved' }], archive: [] }, new Date().toISOString());

    await repo.git('stash', '--include-untracked');
    await repo.checkout('feature/checkout');
    const next = await repo.commit('round the total', { 'src/cart/total.ts': 'export const total = 3;\n' });
    expect(await test.collection.collector().request(response.repo.id, 'refs', 'normal')).toEqual({ ok: true });
    expect(db.changes.get(branch.id)).toMatchObject({ head: next, reviewState: 'unreviewed', lastEventType: 'commit' });
    expect(db.snapshots.latest(branch.id)?.head).toBe(next);
    const commits = db.events.listForRepo(response.repo.id).filter((event) => event.type === 'commit' && event.changeId === branch.id);
    expect(commits.map((event) => (event.payload as { head: string }).head)).toContain(next);
  });
});
