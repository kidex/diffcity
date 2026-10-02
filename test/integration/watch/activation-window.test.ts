// The 7-day activity window of SPEC.md section 3a (Q6, ADR-020): opening a
// repo in the UI (a same-origin GET /api/repos/:id) counts as seeing it, like
// `track`. Every UI open moves the window forward on the daemon's clock, for
// an active repo and an inactive one alike, and the hourly deactivation check
// judges the repo by that window.

import { describe, expect, it } from 'vitest';
import { apiPlugin } from '../../../src/daemon/api/plugin.js';
import { DEACTIVATE_CHECK_MS } from '../../../src/daemon/scheduler/scheduler.js';
import { createWatch, type Watch } from '../../../src/daemon/watcher/plugin.js';
import { manualClock, type ManualClock } from '../../helpers/clock.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const DAY_MS = 24 * 60 * 60 * 1000;

interface Setup {
  test: TestDaemon;
  clock: ManualClock;
  watch: () => Watch;
  /** Moves the daemon's clock to `day` days after the start; the hourly checks due on the way run. */
  toDay(day: number): void;
  /** Opens the repo in the UI: a same-origin GET /api/repos/:id. */
  open(repoId: number): Promise<void>;
  active(repoId: number): boolean;
}

/** A daemon whose collection, watchers and scheduler all run on one manual clock. */
async function daemonOnClock(): Promise<Setup> {
  const clock = manualClock();
  const start = clock.now();
  let watch: Watch | null = null;
  const test = await startTestDaemon(
    { gh: ghNotInstalled(), now: () => new Date(clock.now()) },
    {
      plugins: (collection) => {
        watch = createWatch(collection, { clock });
        return [watch.plugin, apiPlugin];
      },
    },
  );
  return {
    test,
    clock,
    watch: () => {
      if (watch === null) throw new Error('no watch plugin');
      return watch;
    },
    toDay(day) {
      clock.advance(start + day * DAY_MS - clock.now());
    },
    async open(repoId) {
      const response = await fetch(`http://127.0.0.1:${String(test.daemon.info.port)}/api/repos/${String(repoId)}`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    },
    active(repoId) {
      const repo = test.collection.db().repos.get(repoId);
      if (repo === null) throw new Error(`repo ${String(repoId)} gone`);
      return repo.active;
    },
  };
}

async function registered(setup: Setup): Promise<number> {
  const repo = await sampleRepo();
  expect(await setup.test.register([repo.dir])).toMatchObject({ ok: true, registered: 1 });
  await setup.test.idle();
  const [stored] = setup.test.collection.db().repos.list();
  if (stored === undefined) throw new Error('not registered');
  expect(stored.active).toBe(false);
  return stored.id;
}

async function tracked(setup: Setup): Promise<number> {
  const repo = await sampleRepo();
  const response = await setup.test.track(repo.dir, false, new Date(setup.clock.now()).toISOString());
  if (!response.ok) throw new Error(response.error);
  await setup.test.idle();
  expect(setup.active(response.repo.id)).toBe(true);
  return response.repo.id;
}

describe('opening a repo in the UI refreshes its 7-day window (Q6)', () => {
  it('activation/ui-open-refreshes-window: a scanned repo opened at day 0 is active at day 6 and inactive at day 8', async () => {
    const setup = await daemonOnClock();
    const repoId = await registered(setup);

    await setup.open(repoId);
    await setup.test.idle();
    expect(setup.active(repoId)).toBe(true);

    setup.toDay(6);
    expect(setup.active(repoId)).toBe(true);
    setup.toDay(8);
    expect(setup.active(repoId)).toBe(false);
    await waitFor(() => setup.watch().watchers().watched().length === 0, 10_000, 'the watchers to stop');
  });

  it('activation/ui-open-extends-active-window: tracked at day 0 and opened at day 5, active at day 11 and inactive at day 13', async () => {
    const setup = await daemonOnClock();
    const repoId = await tracked(setup);
    const collectEvents = (): number => setup.test.events().filter((record) => record.event === 'collect').length;

    setup.toDay(5);
    expect(setup.active(repoId)).toBe(true);
    // Whatever the advance let fire (a debounced watcher event) settles first.
    await setup.test.idle();
    const collectsBefore = collectEvents();
    const signalsBefore = setup.test.events().length;
    await setup.open(repoId);
    await setup.test.idle();
    // An open of an active repo only moves its window: no collection, no signal.
    expect(collectEvents()).toBe(collectsBefore);
    expect(setup.test.events().length).toBe(signalsBefore);
    expect(setup.test.collection.db().repos.get(repoId)?.lastSeenAt).toBe(new Date(setup.clock.now()).toISOString());

    setup.toDay(11);
    expect(setup.active(repoId)).toBe(true);
    setup.toDay(13);
    expect(setup.active(repoId)).toBe(false);
  });

  it('activation/ui-open-reactivates-inactive: an inactive repo opened in the UI is active again and stays active past the next hourly check', async () => {
    const setup = await daemonOnClock();
    const repoId = await tracked(setup);
    setup.toDay(8);
    expect(setup.active(repoId)).toBe(false);

    await setup.open(repoId);
    expect(setup.active(repoId)).toBe(true);
    await waitFor(() => setup.watch().watchers().watched().includes(repoId), 10_000, 'the watchers of the opened repo');
    await setup.test.idle();

    setup.clock.advance(DEACTIVATE_CHECK_MS + 1);
    expect(setup.active(repoId)).toBe(true);
    expect(setup.watch().scheduler().polled()).toEqual([repoId]);
  });
});
