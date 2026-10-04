// The daemon's scheduler (ADR-020, SPEC.md section 3a C5, L7, Q6). Every timer
// goes through the injected clock.
//
// - PR polling: every PR_POLL_MS ± PR_POLL_JITTER_MS per active repo, a `prs`
//   collection at low priority, skipped while the gh gate says gh is
//   unavailable for that repo (not installed, not authenticated, paused after
//   timeouts). The offset is drawn again for every poll, so repos never line up.
// - Deactivation: at start and every hour, an active repo whose lastSeenAt is
//   more than ACTIVE_WINDOW_MS ago goes inactive; its polling stops and
//   onDeactivated stops its watchers. Its data stays.
// - Maintenance: at start and every 24 h, purgeArchived (archived changes past
//   90 days, with their snapshots) and the pruning of old `collect` events.

import type { Db } from '../../core/db/index.js';
import type { CollectorPort, SseEvent } from '../../core/model/types.js';
import type { Clock, TimerHandle } from '../clock.js';
import { errorMessage, type Logger } from '../log.js';

export const PR_POLL_MS = 15 * 60_000;
export const PR_POLL_JITTER_MS = 60_000;
export const DEACTIVATE_CHECK_MS = 60 * 60_000;
/** A repo stays active this long after it was last seen (Q6). */
export const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MAINTENANCE_MS = 24 * 60 * 60_000;

export interface SchedulerCollector extends CollectorPort {
  /** False while gh is known to be unavailable for this repo. */
  ghUsable(repoId: number): boolean;
}

export interface SchedulerOptions {
  db: Db;
  collector: SchedulerCollector;
  clock: Clock;
  log: Logger;
  broadcast: (event: SseEvent) => void;
  /** A repo just went inactive: stop its watchers. */
  onDeactivated: (repoId: number) => void | Promise<void>;
}

export interface Scheduler {
  /** Runs the maintenance and the deactivation check, then schedules them and the polling of every active repo. */
  start(): void;
  /** Starts polling a repo (activated); idempotent. */
  addRepo(repoId: number): void;
  /** Stops polling a repo. */
  removeRepo(repoId: number): void;
  /** Repos being polled. */
  polled(): number[];
  /** Clears every timer; nothing is scheduled afterwards. */
  close(): void;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db, collector, clock, log } = options;
  const polls = new Map<number, TimerHandle>();
  /** The recurring tasks' pending timers, by task name. */
  const recurring = new Map<string, TimerHandle>();
  let closed = false;
  // Read through a function: a task may close the scheduler while it runs.
  const isClosed = (): boolean => closed;

  const nowIso = (): string => new Date(clock.now()).toISOString();

  function pollDelay(): number {
    return PR_POLL_MS + Math.round((clock.random() * 2 - 1) * PR_POLL_JITTER_MS);
  }

  function schedulePoll(repoId: number): void {
    polls.set(
      repoId,
      clock.setTimeout(() => {
        if (closed || !polls.has(repoId)) return;
        if (collector.ghUsable(repoId)) void collector.request(repoId, 'prs', 'low');
        schedulePoll(repoId);
      }, pollDelay()),
    );
  }

  function removeRepo(repoId: number): void {
    const timer = polls.get(repoId);
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    polls.delete(repoId);
  }

  function deactivateStale(): void {
    const cutoff = clock.now() - ACTIVE_WINDOW_MS;
    for (const repo of db.repos.list()) {
      if (!repo.active || Date.parse(repo.lastSeenAt) >= cutoff) continue;
      db.repos.setActive(repo.id, false);
      removeRepo(repo.id);
      log.info(`repo ${repo.name} (repo ${String(repo.id)}) not seen for 7 days: inactive`);
      options.broadcast({ event: 'repo', data: { repoId: repo.id } });
      Promise.resolve(options.onDeactivated(repo.id)).catch((error: unknown) => {
        log.warn(`stopping the watchers of repo ${String(repo.id)} failed: ${errorMessage(error)}`);
      });
    }
  }

  function maintain(): void {
    const now = nowIso();
    const perRepo = db.purgeArchivedByRepo(now);
    const purged = [...perRepo.values()].reduce((a, b) => a + b, 0);
    // The purge moves each affected repo's archivedCount (DC-64).
    for (const repoId of perRepo.keys()) options.broadcast({ event: 'repo', data: { repoId } });
    const pruned = db.events.pruneCollect(now);
    if (purged > 0 || pruned > 0) log.info(`maintenance: purged ${String(purged)} archived changes, ${String(pruned)} collect events`);
  }

  /** Runs `task` now and then every `everyMs`; a failure is logged and the schedule goes on. */
  function every(name: string, everyMs: number, task: () => void): void {
    const run = (): void => {
      if (isClosed()) return;
      try {
        task();
      } catch (error) {
        log.warn(`${name} failed: ${errorMessage(error)}`);
      }
      if (!isClosed()) recurring.set(name, clock.setTimeout(run, everyMs));
    };
    run();
  }

  return {
    start() {
      if (closed) return;
      every('maintenance', MAINTENANCE_MS, maintain);
      every('deactivation check', DEACTIVATE_CHECK_MS, deactivateStale);
      for (const repo of db.repos.list()) if (repo.active) this.addRepo(repo.id);
    },
    addRepo(repoId) {
      if (closed || polls.has(repoId)) return;
      schedulePoll(repoId);
    },
    removeRepo,
    polled: () => [...polls.keys()],
    close() {
      closed = true;
      for (const timer of polls.values()) clock.clearTimeout(timer);
      polls.clear();
      for (const timer of recurring.values()) clock.clearTimeout(timer);
      recurring.clear();
    },
  };
}
