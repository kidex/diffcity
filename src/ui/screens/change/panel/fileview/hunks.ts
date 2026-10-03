// Next / previous hunk (SPEC.md section 6): `hunks` are row ranges from the
// daemon; the view only walks them. Pure.

import { cleanSpans, type Span } from './layout.js';

export const cleanHunks = (hunks: readonly Span[] | undefined, rowCount: number): Span[] => cleanSpans(hunks, rowCount);

/** The hunk to start at: the first one that ends at or after `row`, else the last. -1 without hunks. */
export function hunkFrom(hunks: readonly Span[], row: number): number {
  if (hunks.length === 0) return -1;
  const found = hunks.findIndex((hunk) => hunk.last >= row);
  return found === -1 ? hunks.length - 1 : found;
}

/** The hunk after (or before) `current`; stays at the ends. */
export function stepHunk(current: number, count: number, direction: 'next' | 'prev'): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 'next' ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + (direction === 'next' ? 1 : -1)));
}

/** "2 / 7": the counter beside the hunk keys; empty without hunks. */
export const hunkCounter = (current: number, count: number): string => (count === 0 ? '' : `${String(current + 1)} / ${String(count)}`);

/**
 * The hunk a scroll position is reading: the last one whose first row is at or
 * above `row`, so the counter follows the reader after a scroll.
 */
export function hunkAtRow(hunks: readonly Span[], row: number): number {
  let found = -1;
  hunks.forEach((hunk, index) => {
    if (hunk.first <= row) found = index;
  });
  return found;
}
