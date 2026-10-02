// Repo activation across plugins (ADR-020, Q6): a repo becomes active when
// `track` runs in it or when it is opened in the UI. The collection plugin
// provides the activation for a daemon context; the API calls it when a
// same-origin GET /api/repos/:id opens an inactive repo. Resolved at call time,
// so plugin order does not matter.

import type { DaemonContext } from './plugin.js';

/** Activates a repo if it is inactive; returns true when it was inactive. */
export type Activate = (repoId: number) => boolean;

const providers = new WeakMap<DaemonContext, Activate>();

export function provideActivation(context: DaemonContext, activate: Activate): void {
  providers.set(context, activate);
}

/** Activates the repo through the daemon's provider; false without one or when it was already active. */
export function activateRepo(context: DaemonContext, repoId: number): boolean {
  return providers.get(context)?.(repoId) ?? false;
}
