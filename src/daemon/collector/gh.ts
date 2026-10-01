// Whether `gh` can list PRs (ADR-020, SPEC.md section 3a C5), learned from the
// outcome of `gh pr list` itself rather than a separate probe, so gh is never
// on the critical path twice (DC-49):
// - gh not installed: every repo skips gh for an hour;
// - `gh pr list` exiting non-zero in a repo (not authenticated, no GitHub
//   remote): that repo skips gh for an hour;
// - a timeout: unavailable for this collection only; after
//   GH_TIMEOUTS_BEFORE_PAUSE timeouts in a row in a repo (a hung GitHub), that
//   repo skips gh for GH_TIMEOUT_PAUSE_MS, so collections stop waiting on it.
// While gh is unavailable the PR step is skipped silently: no error on the repo
// and no PR archived (ADR-019).

import type { OpenPrsOutcome } from '../../core/changes/index.js';

/** How long an unavailable gh is skipped. */
export const GH_UNAVAILABLE_TTL_MS = 60 * 60 * 1000;

/** Consecutive timeouts in a repo after which gh is paused there. */
export const GH_TIMEOUTS_BEFORE_PAUSE = 2;

/** How long gh is skipped in a repo after repeated timeouts. */
export const GH_TIMEOUT_PAUSE_MS = 5 * 60 * 1000;

export interface GhGate {
  /** False while gh is known to be unavailable for this repo. */
  usable(repoId: number): boolean;
  /** Records the outcome of a `gh pr list` in this repo. */
  record(repoId: number, outcome: OpenPrsOutcome): void;
}

export function createGhGate(now: () => Date, ttlMs: number = GH_UNAVAILABLE_TTL_MS): GhGate {
  let missingUntil = 0;
  const repoUntil = new Map<number, number>();
  const timeouts = new Map<number, number>();
  return {
    usable(repoId) {
      const time = now().getTime();
      return time >= missingUntil && time >= (repoUntil.get(repoId) ?? 0);
    },
    record(repoId, outcome) {
      const time = now().getTime();
      if (outcome.ok) {
        missingUntil = 0;
        repoUntil.delete(repoId);
        timeouts.delete(repoId);
      } else if (outcome.reason === 'missing') {
        missingUntil = time + ttlMs;
      } else if (outcome.reason === 'failed') {
        repoUntil.set(repoId, time + ttlMs);
        timeouts.delete(repoId);
      } else {
        const count = (timeouts.get(repoId) ?? 0) + 1;
        if (count >= GH_TIMEOUTS_BEFORE_PAUSE) {
          repoUntil.set(repoId, time + GH_TIMEOUT_PAUSE_MS);
          timeouts.delete(repoId);
        } else {
          timeouts.set(repoId, count);
        }
      }
    },
  };
}
