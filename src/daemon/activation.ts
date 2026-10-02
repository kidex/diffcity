// Opening a repo in the UI across plugins (ADR-020, Q6, SPEC.md section 3a):
// like `track`, it counts as seeing the repo, so it moves the repo's 7-day
// activity window (`lastSeenAt`) forward and makes an inactive repo active
// again. The collection plugin provides the handler for a daemon context, so
// the window is stamped on the same clock as `track` and judged by the
// scheduler's deactivation check; the API calls it when a same-origin
// GET /api/repos/:id opens a repo. Resolved at call time, so plugin order does
// not matter.

import type { DaemonContext } from './plugin.js';

/** Marks a repo as seen in the UI; returns true when it was inactive and is active again. */
export type OpenRepo = (repoId: number) => boolean;

const providers = new WeakMap<DaemonContext, OpenRepo>();

export function provideRepoOpen(context: DaemonContext, open: OpenRepo): void {
  providers.set(context, open);
}

/** Marks the repo as seen through the daemon's provider; false without one or when it was already active. */
export function openRepo(context: DaemonContext, repoId: number): boolean {
  return providers.get(context)?.(repoId) ?? false;
}
