// The display list of the full diff: every row, with the folds (ADR-027)
// collapsed into one line each until they are expanded. Pure.

import type { DiffRow, FileDiff } from '../../../../../core/model/types.js';

export interface Span {
  first: number;
  last: number;
}

/**
 * The daemon's ranges, kept when they are well formed: inside the rows, in
 * order, not overlapping. Anything else is dropped rather than drawn wrong.
 */
export function cleanSpans(spans: readonly Span[] | undefined, rowCount: number): Span[] {
  const kept: Span[] = [];
  let end = -1;
  for (const span of [...(spans ?? [])].sort((a, b) => a.first - b.first)) {
    if (!Number.isInteger(span.first) || !Number.isInteger(span.last) || span.first < 0 || span.last < span.first || span.last >= rowCount) continue;
    if (span.first <= end) continue;
    kept.push({ first: span.first, last: span.last });
    end = span.last;
  }
  return kept;
}

/**
 * What is on screen, in order: a value `>= 0` is a row index, a value `< 0` is
 * the fold `~value` (its rows hidden behind one line).
 */
export interface Items {
  list: Int32Array;
  folds: Span[];
}

/** Folds whose first row is in `expanded` are open; the others take one line. */
export function buildItems(rowCount: number, folds: readonly Span[], expanded: ReadonlySet<number>): Items {
  const clean = cleanSpans(folds, rowCount);
  let hidden = 0;
  for (const fold of clean) if (!expanded.has(fold.first)) hidden += fold.last - fold.first;
  const list = new Int32Array(rowCount - hidden);
  let at = 0;
  let row = 0;
  clean.forEach((fold, k) => {
    if (expanded.has(fold.first)) return;
    while (row < fold.first) list[at++] = row++;
    list[at++] = ~k;
    row = fold.last + 1;
  });
  while (row < rowCount) list[at++] = row++;
  return { list, folds: clean };
}

/** The first and last row an item stands for. */
export function itemRows(items: Items, index: number): Span {
  const value = items.list[index] ?? 0;
  if (value >= 0) return { first: value, last: value };
  return items.folds[~value] ?? { first: 0, last: 0 };
}

/** The item that shows `row`: the row itself, or the fold that hides it. */
export function itemOfRow(items: Items, row: number): number {
  let low = 0;
  let high = items.list.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const { first, last } = itemRows(items, mid);
    if (row < first) high = mid - 1;
    else if (row > last) low = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(items.list.length - 1, low));
}

/** The fold hiding `row`, or null. */
export function foldAt(items: Items, row: number): Span | null {
  const value = items.list[itemOfRow(items, row)];
  return value !== undefined && value < 0 ? (items.folds[~value] ?? null) : null;
}

/** "N unchanged lines". */
export const foldLabel = (fold: Span): string => {
  const count = fold.last - fold.first + 1;
  return `${String(count)} unchanged ${count === 1 ? 'line' : 'lines'}`;
};

/** The row at the top of the viewport and how far the viewport's top is below that item's top edge: what stays put when folds open. */
export function anchorRow(items: Items, scrollTop: number, rowHeight: number): { row: number; offset: number } {
  if (items.list.length === 0) return { row: 0, offset: 0 };
  const index = Math.min(items.list.length - 1, Math.max(0, Math.floor(scrollTop / rowHeight)));
  return { row: itemRows(items, index).first, offset: scrollTop - index * rowHeight };
}

/** The widest row, in characters: the content is that wide plus the gutters. */
export function widestRow(rows: readonly DiffRow[]): number {
  let widest = 0;
  for (const row of rows) if (row.text.length > widest) widest = row.text.length;
  return widest;
}

/** The largest line number on either side, for the gutter's width. */
export function largestLine(rows: readonly DiffRow[]): number {
  let largest = 0;
  for (const row of rows) largest = Math.max(largest, row.old ?? 0, row.new ?? 0);
  return largest;
}

/** The rows of a FileDiff, or none when the daemon sent none. */
export const rowsOf = (diff: FileDiff): DiffRow[] => diff.rows ?? [];
