// The watch plugin in an in-process daemon (SPEC.md section 3a C4, C5, Q6,
// ADR-020): watchers only for active repos, started by `track`, stopped by
// deactivation, a working tree edit recomputing only its own change, and a
// shutdown that releases every watcher and timer.

import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoDetail } from '../../../src/core/model/types.js';
import { apiPlugin } from '../../../src/daemon/api/plugin.js';
import { systemClock, type Clock, type TimerHandle } from '../../../src/daemon/clock.js';
import { getRuntime } from '../../../src/daemon/runtime.js';
import { ACTIVE_WINDOW_MS, DEACTIVATE_CHECK_MS } from '../../../src/daemon/scheduler/scheduler.js';
import { createWatch, type Watch } from '../../../src/daemon/watcher/plugin.js';
import type { WatchEvent } from '../../../src/daemon/watcher/watchers.js';
import { manualClock } from '../../helpers/clock.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

async function daemonWithWatch(clock: Clock = manualClock()): Promise<{ test: TestDaemon; watch: () => Watch; events: WatchEvent[] }> {
  const events: WatchEvent[] = [];
  let watch: Watch | null = null;
  const test = await startTestDaemon({ gh: ghNotInstalled() }, { plugins: (collection) => {
    watch = createWatch(collection, { clock, onEvent: (event) => events.push(event) });
    return [watch.plugin, apiPlugin];
  } });
  return {
    test,
    watch: () => {
      if (watch === null) throw new Error('no watch plugin');
      return watch;
    },
    events,
  };
}

function repoIdOf(response: Awaited<ReturnType<TestDaemon['track']>>): number {
  if (!response.ok) throw new Error(response.error);
  return response.repo.id;
}

describe('activation (C4, Q6)', () => {
  it('watch/inactive-not-watched and watch/reactivated-on-track: a scanned repo has no watcher until `track`', async () => {
    const repo = await sampleRepo();
    const { test, watch } = await daemonWithWatch();
    const registered = await test.register([repo.dir]);
    expect(registered).toMatchObject({ ok: true, registered: 1 });
    await test.idle();
    const db = test.collection.db();
    const [stored] = db.repos.list();
    if (stored === undefined) throw new Error('not registered');
    expect(stored.active).toBe(false);
    expect(watch().watchers().watched()).toEqual([]);
    expect(watch().scheduler().polled()).toEqual([]);
    expect(getRuntime(test.daemon.context)(stored).watch).toBe('off');

    const repoId = repoIdOf(await test.track(repo.dir));
    expect(repoId).toBe(stored.id);
    await waitFor(() => watch().watchers().watched().includes(repoId), 10_000, 'the watchers of the tracked repo');
    expect(watch().scheduler().polled()).toEqual([repoId]);
    const reactivated = db.repos.get(repoId);
    if (reactivated === null) throw new Error('repo gone');
    expect(getRuntime(test.daemon.context)(reactivated).watch).toBe('full');
    await test.idle();
  });

  it('a repo tracked for the first time is watched; an active repo is watched at daemon start', async () => {
    const repo = await sampleRepo();
    const { test, watch } = await daemonWithWatch();
    const repoId = repoIdOf(await test.track(repo.dir));
    await waitFor(() => watch().watchers().watchedWorktrees(repoId).length === 1, 10_000, 'the working tree watcher');
    expect(watch().watchers().watchedWorktrees(repoId)).toEqual([await realpath(repo.dir)]);
    await test.idle();
  });
});

describe('opening a repo in the UI (Q6)', () => {
  it('a same-origin GET /api/repos/:id reactivates an inactive repo and starts its watchers; a cross-site one does not', async () => {
    const repo = await sampleRepo();
    const { test, watch } = await daemonWithWatch();
    await test.register([repo.dir]);
    await test.idle();
    const [stored] = test.collection.db().repos.list();
    if (stored === undefined) throw new Error('not registered');
    expect(stored.active).toBe(false);
    const url = `http://127.0.0.1:${String(test.daemon.info.port)}/api/repos/${String(stored.id)}`;

    const crossSite = await fetch(url, { headers: { origin: 'http://elsewhere.example' } });
    expect(crossSite.status).toBe(200);
    expect(test.collection.db().repos.get(stored.id)?.active).toBe(false);
    expect(watch().watchers().watched()).toEqual([]);

    const detail = (await (await fetch(url)).json()) as RepoDetail;
    expect(detail.repo).toMatchObject({ active: true, watch: 'full' });
    expect(test.collection.db().repos.get(stored.id)?.active).toBe(true);
    await waitFor(() => watch().watchers().watched().includes(stored.id), 10_000, 'the watchers of the opened repo');
    expect(watch().scheduler().polled()).toEqual([stored.id]);
    expect(test.events()).toContainEqual({ event: 'repo', data: { repoId: stored.id } });
    await test.idle();
  });
});

describe('scope of a working tree event (C4)', () => {
  it('watch/worktree-edit-recomputes-only-its-change: an edit in a linked worktree recomputes only its change', async () => {
    const repo = await sampleRepo({ files: { '.gitignore': '.worktrees/\n', 'src/cart/total.ts': 'export const total = 0;\n' } });
    await repo.git('worktree', 'add', '--quiet', '.worktrees/rack', '-b', 'feature/rack');
    const root = await realpath(repo.dir);
    const linked = join(root, '.worktrees', 'rack');
    await repo.git('-C', linked, 'commit', '--quiet', '--allow-empty', '-m', 'start the rack');
    await repo.write({ '.worktrees/rack/src/rack.ts': 'export const rack = 1;\n', 'src/cart/line.ts': 'export const line = 1;\n' });

    const clock = manualClock();
    const { test, watch, events } = await daemonWithWatch(clock);
    const repoId = repoIdOf(await test.track(repo.dir));
    await test.idle();
    await waitFor(() => watch().watchers().watchedWorktrees(repoId).length === 2, 10_000, 'both working tree watchers');
    // Let the setup's own events pass, and run whatever they asked for.
    await new Promise((resolve) => setTimeout(resolve, 300));
    clock.advance(60_000);
    await test.idle();

    const db = test.collection.db();
    const changes = db.changes.listLive(repoId);
    const rack = changes.find((change) => change.worktreePath === linked);
    const draft = changes.find((change) => change.worktreePath === root);
    expect(rack).toMatchObject({ ref: 'branch:feature/rack', dirty: true });
    expect(draft).toMatchObject({ kind: 'draft', dirty: true });
    if (rack === undefined || draft === undefined) throw new Error('changes missing');
    const before = test.events().length;
    events.length = 0;

    // A new symbol, so the report (and its content hash) changes.
    await repo.write({ '.worktrees/rack/src/rack.ts': 'export const rack = 1;\nexport function shelf(): number {\n  return 2;\n}\n' });
    await waitFor(() => events.some((event) => event.scope === `worktree:${linked}`), 10_000, 'the edit event');
    expect(events.every((event) => event.scope === `worktree:${linked}`)).toBe(true);
    clock.advance(2000);
    await waitFor(() => test.events().slice(before).some((record) => record.event === 'snapshot'), 30_000, 'the new snapshot');
    await test.idle();
    const snapshots = test.events().slice(before).filter((record) => record.event === 'snapshot');
    expect(snapshots.map((record) => record.data.changeId)).toEqual([rack.id]);
  });
});

describe('deactivation (Q6)', () => {
  it('7 days without activity: the watchers and the polling of the repo stop', async () => {
    const repo = await sampleRepo();
    const clock = manualClock();
    const { test, watch } = await daemonWithWatch(clock);
    const repoId = repoIdOf(await test.track(repo.dir, false, new Date(clock.now()).toISOString()));
    await waitFor(() => watch().watchers().watched().includes(repoId), 10_000, 'the watchers');
    await test.idle();
    clock.advance(ACTIVE_WINDOW_MS + DEACTIVATE_CHECK_MS);
    await waitFor(() => watch().watchers().watched().length === 0, 10_000, 'the watchers to stop');
    expect(test.collection.db().repos.get(repoId)?.active).toBe(false);
    expect(watch().scheduler().polled()).toEqual([]);
    await test.idle();
  });
});

/** systemClock, counting the timers that are neither fired nor cleared. */
function countingClock(): Clock & { live(): number } {
  const live = new Set<TimerHandle>();
  return {
    ...systemClock,
    setTimeout(fn, ms) {
      const handle = systemClock.setTimeout(() => {
        live.delete(handle);
        fn();
      }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      live.delete(handle);
      systemClock.clearTimeout(handle);
    },
    live: () => live.size,
  };
}

const fsWatchHandles = (): number => process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length;

describe('activation cycles (Q6)', () => {
  it('10 activate/deactivate cycles keep the fs.watch handles and the live timers flat', { timeout: 240_000 }, async () => {
    const repo = await sampleRepo({ files: { '.gitignore': 'dist/\n', 'src/pantry/jar.ts': 'export const jar = 1;\n' } });
    const clock = manualClock();
    const { test, watch } = await daemonWithWatch(clock);
    const baseline = fsWatchHandles();
    const idleTimers = clock.pending();
    const active: { handles: number; timers: number }[] = [];
    const inactive: { handles: number; timers: number }[] = [];

    for (let cycle = 0; cycle < 10; cycle++) {
      const repoId = repoIdOf(await test.track(repo.dir, false, new Date(clock.now()).toISOString()));
      await waitFor(() => watch().watchers().watchedWorktrees(repoId).length === 1, 10_000, `the watchers, cycle ${String(cycle)}`);
      await test.idle();
      // Let the collection's own events pass and flush their debounce.
      await new Promise((resolve) => setTimeout(resolve, 300));
      clock.advance(60_000);
      await test.idle();
      active.push({ handles: fsWatchHandles(), timers: clock.pending() });

      clock.advance(ACTIVE_WINDOW_MS + DEACTIVATE_CHECK_MS);
      await waitFor(() => watch().watchers().watched().length === 0, 10_000, `the watchers to stop, cycle ${String(cycle)}`);
      expect(test.collection.db().repos.get(repoId)?.active).toBe(false);
      await waitFor(() => fsWatchHandles() === baseline, 5000, `the fs.watch handles to close, cycle ${String(cycle)}`);
      await test.idle();
      inactive.push({ handles: fsWatchHandles(), timers: clock.pending() });
    }

    const first = active[0];
    if (first === undefined) throw new Error('no cycle ran');
    expect(first.handles).toBeGreaterThan(baseline);
    expect(active).toEqual(Array.from({ length: 10 }, () => first));
    // Inactive: only the scheduler's two recurring tasks (maintenance, deactivation check).
    expect(inactive).toEqual(Array.from({ length: 10 }, () => ({ handles: baseline, timers: idleTimers })));
    expect(idleTimers).toBe(2);
    expect(watch().scheduler().polled()).toEqual([]);
    expect(watch().watchers().pending()).toBe(0);
  });
});

describe('shutdown', () => {
  it('closes every watcher and clears every timer', async () => {
    const baseline = fsWatchHandles();
    const repo = await sampleRepo({ files: { '.gitignore': '.worktrees/\n', 'README.md': '# sample-shop\n' } });
    await repo.git('worktree', 'add', '--quiet', '.worktrees/rack', '-b', 'feature/rack');
    const clock = countingClock();
    const { test, watch } = await daemonWithWatch(clock);
    const repoId = repoIdOf(await test.track(repo.dir));
    await waitFor(() => watch().watchers().watchedWorktrees(repoId).length === 2, 10_000, 'both working tree watchers');
    await repo.write({ 'src/cart/new.ts': 'export const fresh = 1;\n' });
    await waitFor(() => watch().watchers().pending() > 0, 10_000, 'a pending debounce');
    expect(fsWatchHandles()).toBeGreaterThan(baseline);
    expect(clock.live()).toBeGreaterThan(0);

    await test.daemon.shutdown('test');
    expect(clock.live()).toBe(0);
    expect(() => watch().watchers()).toThrow(/not running/);
    // fs.watch handles are released on the next turns of the loop.
    await waitFor(() => fsWatchHandles() === baseline, 5000, 'the fs.watch handles to close');
  });
});
