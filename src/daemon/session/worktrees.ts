// The working trees of a repo as its last collection listed them, across
// plugins (ADR-038): the collection plugin provides them for a daemon context,
// and the sessions route reads them to tell which working tree a run worked
// in, the same listing the session tracker links with. Resolved at call time,
// so plugin order does not matter.

import type { DaemonContext } from '../plugin.js';

/** Realpaths of the repo's working trees; null when the repo was never listed in this daemon. */
export type WorktreeLister = (repoId: number) => readonly string[] | null;

const providers = new WeakMap<DaemonContext, WorktreeLister>();

export function provideWorktrees(context: DaemonContext, lister: WorktreeLister): void {
  providers.set(context, lister);
}

/** The listed working trees of a repo; null without a provider or a listing. */
export function listedWorktrees(context: DaemonContext, repoId: number): readonly string[] | null {
  return providers.get(context)?.(repoId) ?? null;
}
