// Per-repo daemon state that is not in the database, for RepoSummary
// (ADR-017): `collecting` and `notes` come from the collector, `watch` from
// the watchers (ADR-020). Plugins provide their part for a daemon context; the API reads
// getRuntime(context) as the RepoRuntimeLookup of the repo store. The lookup
// resolves at call time, so plugin order does not matter.

import type { RepoRuntimeLookup } from '../core/db/index.js';
import type { RepoNote, RepoRecord, WatchMode } from '../core/model/types.js';
import type { DaemonContext } from './plugin.js';

export interface RuntimeProviders {
  /** True while the repo has a collection queued or running. */
  collecting?: (repoId: number) => boolean;
  /** How the repo is watched; without a provider, `full` when active and `off` otherwise. */
  watch?: (repo: RepoRecord) => WatchMode;
  /** Non-fatal notes on the repo (ADR-030); none without a provider. */
  notes?: (repoId: number) => RepoNote[];
}

const providers = new WeakMap<DaemonContext, RuntimeProviders>();

/** Adds or replaces providers for a daemon. */
export function provideRuntime(context: DaemonContext, part: RuntimeProviders): void {
  providers.set(context, { ...providers.get(context), ...part });
}

/** The runtime lookup of a daemon, for RepoStore.listSummaries and getSummary. */
export function getRuntime(context: DaemonContext): RepoRuntimeLookup {
  return (repo) => {
    const current = providers.get(context);
    return {
      collecting: current?.collecting?.(repo.id) ?? false,
      watch: current?.watch?.(repo) ?? (repo.active ? 'full' : 'off'),
      notes: current?.notes?.(repo.id) ?? [],
    };
  };
}
