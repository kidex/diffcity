// The line-range selection of the file view (ADR-028 `lines`): a click on a
// line number picks a line, Shift+click extends the range on the same side.
// Kept as state for the review marks (T10); nothing here draws a mark. Pure.

import type { DiffRow } from '../../../../../core/model/types.js';

export interface LineRange {
  side: 'old' | 'new';
  start: number;
  end: number;
}

/** A click on the `side` number of a line, with the anchor the last plain click left. */
export interface Pick {
  range: LineRange;
  anchor: { side: 'old' | 'new'; line: number };
}

/** A plain click starts a range at the line; Shift+click extends from the anchor on the same side, or starts over on the other side. */
export function pickLine(previous: Pick | null, side: 'old' | 'new', line: number, extend: boolean): Pick {
  if (extend && previous !== null && previous.anchor.side === side) {
    const { line: from } = previous.anchor;
    return { anchor: previous.anchor, range: { side, start: Math.min(from, line), end: Math.max(from, line) } };
  }
  return { anchor: { side, line }, range: { side, start: line, end: line } };
}

/** The line number a row has on `side`. */
export const lineOn = (row: DiffRow, side: 'old' | 'new'): number | null => (side === 'old' ? row.old : row.new);

/** Whether `row` is in the range. */
export function inRange(range: LineRange | null, row: DiffRow): boolean {
  if (range === null) return false;
  const line = lineOn(row, range.side);
  return line !== null && line >= range.start && line <= range.end;
}

export const sameRange = (a: LineRange | null, b: LineRange | null): boolean =>
  a === b || (a !== null && b !== null && a.side === b.side && a.start === b.start && a.end === b.end);

/** "new 3-5" or "old 7": the range as a person (and a test) reads it. */
export const describeRange = (range: LineRange): string =>
  `${range.side} ${range.start === range.end ? String(range.start) : `${String(range.start)}-${String(range.end)}`}`;
