// A row's highlight ranges as the pieces of its text, so the view can build
// them as DOM nodes (the text is repository content: never markup). Pure.

import type { DiffRow, HighlightClass } from '../../../../../core/model/types.js';

export interface Piece {
  text: string;
  /** The highlight class; undefined for plain text. */
  cls?: HighlightClass;
}

const CLASSES: ReadonlySet<string> = new Set(['kw', 'str', 'num', 'com', 'type', 'fn', 'prop', 'op', 'punc', 'var']);

/** The class name a highlight class gets in the DOM; the CSS maps each to a `--code-*` token. */
export const hlClass = (cls: HighlightClass): string => `hl-${cls}`;

/**
 * The text cut at the highlight ranges. Ranges that are out of order, overlap
 * an earlier one, run past the text or name an unknown class are skipped.
 */
export function segments(text: string, hl: DiffRow['hl']): Piece[] {
  if (!Array.isArray(hl) || hl.length === 0) return text === '' ? [] : [{ text }];
  const pieces: Piece[] = [];
  let at = 0;
  const ranges = hl.filter((range) => Array.isArray(range));
  for (const [start, end, cls] of ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (!CLASSES.has(cls) || !Number.isInteger(start) || !Number.isInteger(end)) continue;
    const from = Math.max(start, 0);
    const to = Math.min(end, text.length);
    if (from < at || to <= from) continue;
    if (from > at) pieces.push({ text: text.slice(at, from) });
    pieces.push({ text: text.slice(from, to), cls });
    at = to;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}
