// The Repo filters (SPEC.md section 6): by kind and by review state, with the
// behaviour of the mockup's filter chips. Each row of chips holds at most one
// active value; clicking the active chip turns it off; the two rows combine
// with AND; "Show everything" clears both. Filtering only: the list keeps the
// API order and every counter is a count of the rows as the daemon sent them.

import type { ChangeKind, ChangeSummary, ReviewState } from '../../../core/model/types.js';

export interface RepoFilters {
  kind: ChangeKind | null;
  review: ReviewState | null;
}

export const NO_FILTERS: RepoFilters = { kind: null, review: null };

/** The filters after a click on the kind chip `kind`: on, or off when it was the active one. */
export function toggleKind(filters: RepoFilters, kind: ChangeKind): RepoFilters {
  return { ...filters, kind: filters.kind === kind ? null : kind };
}

/** The filters after a click on the review-state chip `review`: on, or off when it was the active one. */
export function toggleReview(filters: RepoFilters, review: ReviewState): RepoFilters {
  return { ...filters, review: filters.review === review ? null : review };
}

export function isFiltered(filters: RepoFilters): boolean {
  return filters.kind !== null || filters.review !== null;
}

/** The changes that pass both filters, in the order given. */
export function applyFilters<T extends Pick<ChangeSummary, 'kind' | 'reviewState'>>(changes: readonly T[], filters: RepoFilters): T[] {
  return changes.filter(
    (change) => (filters.kind === null || change.kind === filters.kind) && (filters.review === null || change.reviewState === filters.review),
  );
}

export interface FilterCounts {
  kind: Record<ChangeKind, number>;
  review: Record<ReviewState, number>;
}

/**
 * The chip counters: how many of the listed changes have each kind and each
 * review state. Like the mockup's chips, they count the whole list, not the
 * filtered one, so a chip's number does not move when the other row is used.
 */
export function filterCounts(changes: readonly Pick<ChangeSummary, 'kind' | 'reviewState'>[]): FilterCounts {
  const counts: FilterCounts = {
    kind: { draft: 0, branch: 0, pr: 0 },
    review: { unreviewed: 0, 'in-review': 0, approved: 0 },
  };
  for (const change of changes) {
    counts.kind[change.kind]++;
    counts.review[change.reviewState]++;
  }
  return counts;
}
