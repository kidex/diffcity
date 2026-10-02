// ui/repo-filters (SPEC.md section 6): kind and review-state filters behave
// like the mockup's chips: one value per row, a click on the active chip turns
// it off, the rows combine with AND, "Show everything" clears both, and the
// list keeps the API order.

import { describe, expect, it } from 'vitest';
import type { ChangeKind, ReviewState } from '../../../src/core/model/types.js';
import { applyFilters, filterCounts, isFiltered, NO_FILTERS, toggleKind, toggleReview } from '../../../src/ui/screens/repo/filters.js';

const row = (id: number, kind: ChangeKind, reviewState: ReviewState) => ({ id, kind, reviewState });

// In API order (last event desc).
const CHANGES = [
  row(11, 'branch', 'unreviewed'),
  row(10, 'draft', 'unreviewed'),
  row(12, 'pr', 'in-review'),
  row(13, 'branch', 'approved'),
  row(14, 'pr', 'unreviewed'),
];

const ids = (changes: { id: number }[]): number[] => changes.map((change) => change.id);

describe('ui/repo-filters', () => {
  it('shows every change in API order without filters', () => {
    expect(ids(applyFilters(CHANGES, NO_FILTERS))).toEqual([11, 10, 12, 13, 14]);
    expect(isFiltered(NO_FILTERS)).toBe(false);
  });

  it('filters by kind and keeps the order', () => {
    expect(ids(applyFilters(CHANGES, toggleKind(NO_FILTERS, 'branch')))).toEqual([11, 13]);
    expect(ids(applyFilters(CHANGES, toggleKind(NO_FILTERS, 'pr')))).toEqual([12, 14]);
  });

  it('filters by review state', () => {
    expect(ids(applyFilters(CHANGES, toggleReview(NO_FILTERS, 'unreviewed')))).toEqual([11, 10, 14]);
  });

  it('combines kind and review state with AND', () => {
    const filters = toggleReview(toggleKind(NO_FILTERS, 'pr'), 'unreviewed');
    expect(ids(applyFilters(CHANGES, filters))).toEqual([14]);
    expect(ids(applyFilters(CHANGES, toggleReview(toggleKind(NO_FILTERS, 'draft'), 'approved')))).toEqual([]);
  });

  it('turns the active chip off on a second click and switches on a click on another chip', () => {
    const on = toggleKind(NO_FILTERS, 'branch');
    expect(on).toEqual({ kind: 'branch', review: null });
    expect(toggleKind(on, 'branch')).toEqual(NO_FILTERS);
    expect(toggleKind(on, 'draft')).toEqual({ kind: 'draft', review: null });
    const both = toggleReview(on, 'approved');
    expect(toggleReview(both, 'approved')).toEqual({ kind: 'branch', review: null });
    expect(isFiltered(both)).toBe(true);
  });

  it('counts every listed change per kind and per review state, whatever the filters', () => {
    expect(filterCounts(CHANGES)).toEqual({
      kind: { draft: 1, branch: 2, pr: 2 },
      review: { unreviewed: 3, 'in-review': 1, approved: 1 },
    });
    expect(filterCounts([])).toEqual({ kind: { draft: 0, branch: 0, pr: 0 }, review: { unreviewed: 0, 'in-review': 0, approved: 0 } });
  });
});
