// The watch plugin (ADR-020, SPEC.md section 3a C4, C5, L7, Q6): the watchers
// of the active repos and the scheduler, on top of the collection plugin,
// which must be listed before it.
//
// - start: the scheduler runs its maintenance and deactivation check, then the
//   watchers start for every repo still active. The collection plugin already
//   collects every active repo at start; nothing is collected here.
// - `track` on a new or inactive repo (Collection.onActivated): its watchers
//   start and its PRs are polled.
// - each collection (Collection.onListed): the watchers follow the listed
//   working trees and recompute their ignores.
// - deactivation (scheduler): the watchers stop.
// - stop: the hooks, the scheduler's timers and every watcher are released.
//
// RepoSummary.watch comes from here: `off` when inactive, `git-only` once a
// working tree went over budget, `full` otherwise.

import type { Collection } from '../collector/plugin.js';
import { systemClock, type Clock } from '../clock.js';
import type { DaemonContext, DaemonPlugin } from '../plugin.js';
import { provideRuntime } from '../runtime.js';
import { createScheduler, type Scheduler } from '../scheduler/scheduler.js';
import { createWatchers, type WatchEvent, type Watchers } from './watchers.js';

export interface WatchPluginOptions {
  clock?: Clock;
  /** Directory budget per working tree; defaults to DIR_BUDGET. */
  budget?: number;
  /** Every event that passed the filters, before the debounce (tests). */
  onEvent?: (event: WatchEvent) => void;
}

export interface Watch {
  readonly plugin: DaemonPlugin;
  /** The watchers, created at start; throws before start and after stop. */
  watchers(): Watchers;
  /** The scheduler, created at start; throws before start and after stop. */
  scheduler(): Scheduler;
}

export function createWatch(collection: Collection, options: WatchPluginOptions = {}): Watch {
  const clock = options.clock ?? systemClock;
  let watchers: Watchers | null = null;
  let scheduler: Scheduler | null = null;
  let unsubscribe: (() => void)[] = [];

  const need = <T>(value: T | null, what: string): T => {
    if (value === null) throw new Error(`the ${what} is not running`);
    return value;
  };

  const plugin: DaemonPlugin = {
    name: 'watch',
    setup(context: DaemonContext) {
      provideRuntime(context, {
        watch: (repo) => {
          if (!repo.active) return 'off';
          return watchers?.mode(repo.id) === 'git-only' ? 'git-only' : 'full';
        },
      });
    },
    start(context: DaemonContext) {
      const db = collection.db();
      const collector = collection.collector();
      const broadcastRepo = (repoId: number): void => {
        context.broadcast({ event: 'repo', data: { repoId } });
      };
      const createdWatchers = createWatchers({
        collector,
        clock,
        log: context.log,
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        onModeChange: broadcastRepo,
      });
      watchers = createdWatchers;
      const createdScheduler = createScheduler({
        db,
        collector,
        clock,
        log: context.log,
        broadcast: (event) => {
          context.broadcast(event);
        },
        onDeactivated: (repoId) => createdWatchers.stop(repoId),
      });
      scheduler = createdScheduler;
      unsubscribe = [
        collection.onActivated((repoId) => {
          const repo = db.repos.get(repoId);
          if (repo === null) return;
          void createdWatchers.start(repo);
          createdScheduler.addRepo(repoId);
        }),
        collection.onListed((repoId, worktrees) => {
          createdWatchers.worktreesListed(
            repoId,
            worktrees.map((worktree) => worktree.path),
          );
        }),
      ];
      createdScheduler.start();
      for (const repo of db.repos.list()) if (repo.active) void createdWatchers.start(repo);
    },
    async stop() {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      scheduler?.close();
      scheduler = null;
      const current = watchers;
      watchers = null;
      await current?.close();
    },
  };

  return {
    plugin,
    watchers: () => need(watchers, 'watchers'),
    scheduler: () => need(scheduler, 'scheduler'),
  };
}
