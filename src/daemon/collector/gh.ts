// Whether `gh` can list PRs (ADR-020, SPEC.md section 3a C5), learned from the
// outcome of `gh pr list` itself rather than a separate probe, so gh is never
// on the critical path twice (DC-49):
// - gh not installed: every repo skips gh for an hour;
// - `gh pr list` exiting non-zero in a repo (not authenticated, no GitHub
//   remote): that repo skips gh for an hour;
// - a timeout: unavailable for this collection only.
// While gh is unavailable the PR step is skipped silently: no error on the repo
// and no PR archived (ADR-019).

import type { OpenPrsOutcome } from '../../core/changes/index.js';

/** How long an unavailable gh is skipped. */
export const GH_UNAVAILABLE_TTL_MS = 60 * 60 * 1000;

export interface GhGate {
  /** False while gh is known to be unavailable for this repo. */
  usable(repoId: number): boolean;
  /** Records the outcome of a `gh pr list` in this repo. */
  record(repoId: number, outcome: OpenPrsOutcome): void;
}

export function createGhGate(now: () => Date, ttlMs: number = GH_UNAVAILABLE_TTL_MS): GhGate {
  let missingUntil = 0;
  const repoUntil = new Map<number, number>();
  return {
    usable(repoId) {
      const time = now().getTime();
      return time >= missingUntil && time >= (repoUntil.get(repoId) ?? 0);
    },
    record(repoId, outcome) {
      const until = now().getTime() + ttlMs;
      if (outcome.ok) {
        missingUntil = 0;
        repoUntil.delete(repoId);
      } else if (outcome.reason === 'missing') {
        missingUntil = until;
      } else if (outcome.reason === 'failed') {
        repoUntil.set(repoId, until);
      }
    },
  };
}
