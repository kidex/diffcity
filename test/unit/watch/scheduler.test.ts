// The scheduler (ADR-020, SPEC.md section 3a C5, L7, Q6): PR polling every
// 15 min ± 60 s per active repo through the gh gate, deactivation after 7 days
// checked hourly, purge and collect-event pruning at start and every 24 h.
// Fake timers, a temporary database and a collector stub that runs the real
// gh gate on a stubbed gh.

import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenPrs } from '../../../src/core/changes/index.js';
import type { CommandRunner } from '../../../src/core/git/index.js';
import type { CollectPriority, CollectScope, SseEvent } from '../../../src/core/model/types.js';
import { systemClock, type Clock } from '../../../src/daemon/clock.js';
import { createGhGate, GH_UNAVAILABLE_TTL_MS } from '../../../src/daemon/collector/gh.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import {
  ACTIVE_WINDOW_MS,
  createScheduler,
  DEACTIVATE_CHECK_MS,
  MAINTENANCE_MS,
  PR_POLL_JITTER_MS,
  PR_POLL_MS,
  type Scheduler,
} from '../../../src/daemon/scheduler/scheduler.js';
import { fakeRunner } from '../../helpers/git-env.js';
import { addRepo, branchFields, daysAfter, T0, tempDb, type TempDb } from '../db/db-helpers.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Request {
  repoId: number;
  scope: CollectScope;
  priority: CollectPriority;
}

let temp: TempDb;
let scheduler: Scheduler | null = null;
let logged = '';

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(T0) });
  temp = tempDb();
  logged = '';
});
afterEach(() => {
  scheduler?.close();
  scheduler = null;
  temp.cleanup();
  vi.useRealTimers();
});

/** A collector whose `prs` requests run `gh pr list` through the real gate, as the collector does. */
function stubCollector(gh: CommandRunner) {
  const gate = createGhGate(() => new Date());
  const requests: Request[] = [];
  return {
    requests,
    gate,
    collector: {
      request: async (repoId: number, scope: CollectScope, priority: CollectPriority) => {
        requests.push({ repoId, scope, priority });
        if (scope === 'prs' && gate.usable(repoId)) gate.record(repoId, await fetchOpenPrs(`/work/repo-${String(repoId)}`, gh));
        return { ok: true as const };
      },
      ghUsable: (repoId: number) => gate.usable(repoId),
    },
  };
}

function start(collector: ReturnType<typeof stubCollector>['collector'], options: { clock?: Clock; onDeactivated?: (id: number) => void } = {}) {
  const events: SseEvent[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    logged += chunk.toString('utf8');
  });
  scheduler = createScheduler({
    db: temp.db,
    collector,
    clock: options.clock ?? { ...systemClock, random: () => 0.5 },
    log: createStreamLogger(stream),
    broadcast: (event) => events.push(event),
    onDeactivated: options.onDeactivated ?? (() => undefined),
  });
  scheduler.start();
  return { scheduler, events };
}

const prPolls = (requests: Request[], repoId?: number): Request[] =>
  requests.filter((request) => request.scope === 'prs' && (repoId === undefined || request.repoId === repoId));

describe('scheduler constants (ADR-020)', () => {
  it('15 min ± 60 s, hourly deactivation over 7 days, daily maintenance', () => {
    expect(PR_POLL_MS).toBe(15 * MINUTE);
    expect(PR_POLL_JITTER_MS).toBe(MINUTE);
    expect(DEACTIVATE_CHECK_MS).toBe(HOUR);
    expect(ACTIVE_WINDOW_MS).toBe(7 * DAY);
    expect(MAINTENANCE_MS).toBe(DAY);
  });
});

describe('PR polling (C5)', () => {
  it('sched/gh-poll-15-min: `gh pr list` at 15 min per active repo, at low priority, none for an inactive repo', async () => {
    const shop = addRepo(temp.db, 'sample-shop');
    const bakery = addRepo(temp.db, 'sample-bakery');
    const idle = addRepo(temp.db, 'sample-idle', false);
    const gh = fakeRunner(() => '[]');
    const stub = stubCollector(gh.runner);
    start(stub.collector);

    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(prPolls(stub.requests)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(prPolls(stub.requests)).toEqual([
      { repoId: shop.id, scope: 'prs', priority: 'low' },
      { repoId: bakery.id, scope: 'prs', priority: 'low' },
    ]);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(prPolls(stub.requests, shop.id)).toHaveLength(2);
    expect(prPolls(stub.requests, bakery.id)).toHaveLength(2);
    expect(prPolls(stub.requests, idle.id)).toEqual([]);
    expect(gh.calls.filter((call) => call.args[0] === 'pr')).toHaveLength(4);
  });

  it('spreads the repos by a random offset of up to 60 s', async () => {
    addRepo(temp.db, 'sample-shop');
    const stub = stubCollector(fakeRunner(() => '[]').runner);
    start(stub.collector, { clock: { ...systemClock, random: () => 0 } });
    await vi.advanceTimersByTimeAsync(14 * MINUTE - 1);
    expect(prPolls(stub.requests)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(prPolls(stub.requests)).toHaveLength(1);

    scheduler?.close();
    const late = stubCollector(fakeRunner(() => '[]').runner);
    start(late.collector, { clock: { ...systemClock, random: () => 0.9999999 } });
    await vi.advanceTimersByTimeAsync(16 * MINUTE - 1);
    expect(prPolls(late.requests)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(prPolls(late.requests)).toHaveLength(1);
  });

  it('sched/gh-missing-skipped: without gh the poll asks nothing and logs no error, until the gate reopens', async () => {
    const shop = addRepo(temp.db, 'sample-shop');
    const gh = fakeRunner(() => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    const stub = stubCollector(gh.runner);
    start(stub.collector);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    // The first poll learns gh is missing; the next ones within the hour are skipped.
    expect(prPolls(stub.requests, shop.id)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(45 * MINUTE - 1);
    expect(prPolls(stub.requests, shop.id)).toHaveLength(1);
    expect(gh.calls).toHaveLength(1);
    expect(temp.db.repos.get(shop.id)?.collectError).toBeNull();
    expect(logged).not.toMatch(/error/i);
    await vi.advanceTimersByTimeAsync(GH_UNAVAILABLE_TTL_MS);
    expect(prPolls(stub.requests, shop.id).length).toBeGreaterThan(1);
  });

  it('sched/gh-unauthenticated-skipped: gh failing in a repo skips that repo only', async () => {
    const shop = addRepo(temp.db, 'sample-shop');
    const bakery = addRepo(temp.db, 'sample-bakery');
    const gh = fakeRunner((call) => {
      if (call.cwd.endsWith(`repo-${String(shop.id)}`)) throw Object.assign(new Error('gh auth login required'), { code: 4 });
      return '[]';
    });
    const stub = stubCollector(gh.runner);
    start(stub.collector);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(prPolls(stub.requests, shop.id)).toHaveLength(1);
    expect(prPolls(stub.requests, bakery.id)).toHaveLength(3);
    expect(logged).not.toMatch(/error/i);
  });

  it('addRepo starts polling a reactivated repo, removeRepo stops it', async () => {
    const idle = addRepo(temp.db, 'sample-idle', false);
    const stub = stubCollector(fakeRunner(() => '[]').runner);
    const { scheduler: running } = start(stub.collector);
    running.addRepo(idle.id);
    running.addRepo(idle.id);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(prPolls(stub.requests, idle.id)).toHaveLength(1);
    running.removeRepo(idle.id);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(prPolls(stub.requests, idle.id)).toHaveLength(1);
  });
});

describe('deactivation (Q6)', () => {
  it('sched/deactivate-after-7-days: a repo not seen for 7 days goes inactive at the next hourly check', async () => {
    const shop = addRepo(temp.db, 'sample-shop');
    const bakery = addRepo(temp.db, 'sample-bakery');
    temp.db.repos.touchSeen(bakery.id, daysAfter(T0, 3));
    const deactivated: number[] = [];
    const stub = stubCollector(fakeRunner(() => '[]').runner);
    const { events } = start(stub.collector, { onDeactivated: (id) => deactivated.push(id) });

    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(temp.db.repos.get(shop.id)?.active).toBe(true);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(temp.db.repos.get(shop.id)?.active).toBe(false);
    expect(temp.db.repos.get(bakery.id)?.active).toBe(true);
    expect(deactivated).toEqual([shop.id]);
    expect(events).toContainEqual({ event: 'repo', data: { repoId: shop.id } });

    // Its polling stopped with it.
    const polls = prPolls(stub.requests, shop.id).length;
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(prPolls(stub.requests, shop.id)).toHaveLength(polls);
    expect(prPolls(stub.requests, bakery.id).length).toBeGreaterThan(polls);
  });

  it('checks at start too, so a daemon started after a week away drops the stale repos at once', () => {
    vi.setSystemTime(Date.parse(daysAfter(T0, 10)));
    const shop = addRepo(temp.db, 'sample-shop');
    const deactivated: number[] = [];
    start(stubCollector(fakeRunner(() => '[]').runner).collector, { onDeactivated: (id) => deactivated.push(id) });
    expect(temp.db.repos.get(shop.id)?.active).toBe(false);
    expect(deactivated).toEqual([shop.id]);
  });
});

describe('maintenance (L7, ADR-018)', () => {
  it('sched/purge-daily: purgeArchived and pruneCollect at start and every 24 h', async () => {
    const shop = addRepo(temp.db, 'sample-shop');
    const at = (days: number) => daysAfter(T0, days);
    const archive = (name: string, archivedAt: string): number => {
      const [change] = temp.db.changes.applyPlan(shop.id, { create: [branchFields(name)], update: [], archive: [] }, at(-200)).created;
      if (change === undefined) throw new Error('not created');
      temp.db.changes.applyPlan(shop.id, { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] }, archivedAt);
      return change.id;
    };
    const old = archive('feature/old', at(-91));
    const recent = archive('feature/recent', at(-89.5));
    temp.db.events.add({ repoId: shop.id, changeId: null, type: 'collect', at: at(-91), payload: null });
    temp.db.events.add({ repoId: shop.id, changeId: null, type: 'collect', at: at(-89.5), payload: null });
    const stub = stubCollector(fakeRunner(() => '[]').runner);
    start(stub.collector);

    expect(temp.db.changes.get(old)).toBeNull();
    expect(temp.db.changes.get(recent)).not.toBeNull();
    expect(temp.db.events.listForRepo(shop.id).filter((event) => event.type === 'collect')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(temp.db.changes.get(recent)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(temp.db.changes.get(recent)).toBeNull();
    expect(temp.db.events.listForRepo(shop.id).filter((event) => event.type === 'collect')).toEqual([]);
  });
});

describe('close', () => {
  it('clears every timer', async () => {
    addRepo(temp.db, 'sample-shop');
    addRepo(temp.db, 'sample-bakery');
    const stub = stubCollector(fakeRunner(() => '[]').runner);
    const { scheduler: running } = start(stub.collector);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    running.close();
    expect(vi.getTimerCount()).toBe(0);
    running.addRepo(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
