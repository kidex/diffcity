// The file view's pure helpers (ADR-027, ADR-028): windowing arithmetic, the
// display list with folds, next/previous hunk, line-range selection, the
// pieces of a highlighted row, symbol owners and the state texts.

import { describe, expect, it } from 'vitest';
import type { DiffRow } from '../../../src/core/model/types.js';
import { cleanHunks, hunkAtRow, hunkCounter, hunkFrom, stepHunk } from '../../../src/ui/screens/change/panel/fileview/hunks.js';
import {
  anchorRow,
  buildItems,
  cleanSpans,
  foldAt,
  foldLabel,
  itemOfRow,
  itemRows,
  largestLine,
  widestRow,
} from '../../../src/ui/screens/change/panel/fileview/layout.js';
import { describeRange, inRange, pickLine, sameRange } from '../../../src/ui/screens/change/panel/fileview/range.js';
import { hlClass, segments } from '../../../src/ui/screens/change/panel/fileview/segments.js';
import { cleanSymbols, owners, spanOf } from '../../../src/ui/screens/change/panel/fileview/spans.js';
import { formatBytes, sizesLine, statsLine } from '../../../src/ui/screens/change/panel/fileview/text.js';
import { anchoredScroll, maxScroll, scrollToItem, visibleRange } from '../../../src/ui/screens/change/panel/fileview/window.js';

const row = (kind: DiffRow['kind'], old: number | null, now: number | null, text = ''): DiffRow => ({ kind, old, new: now, text });

describe('fileview/window', () => {
  it('keeps the visible items and the overscan, never beyond the list', () => {
    expect(visibleRange(0, 100, 20, 1000, 5)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(2000, 100, 20, 1000, 5)).toEqual({ start: 95, end: 110 });
    expect(visibleRange(19_900, 100, 20, 1000, 5)).toEqual({ start: 990, end: 1000 });
    expect(visibleRange(0, 100, 20, 0, 5)).toEqual({ start: 0, end: 0 });
  });

  it('a 50,000-item list never needs more than the viewport and the overscan', () => {
    const range = visibleRange(400_000, 600, 19, 50_000, 24);
    expect(range.end - range.start).toBeLessThanOrEqual(Math.ceil(600 / 19) + 2 * 24 + 1);
  });

  it('scrolls an item to `lead` rows below the top, within the content', () => {
    expect(scrollToItem(100, 20, 200, 1000, 2)).toBe(1960);
    expect(scrollToItem(1, 20, 200, 1000, 2)).toBe(0);
    expect(scrollToItem(999, 20, 200, 1000, 2)).toBe(maxScroll(1000, 20, 200));
  });

  it('keeps the anchor: the item that was at the top stays there, at the same offset', () => {
    expect(anchoredScroll(30, 7, 20)).toBe(607);
    expect(anchoredScroll(0, -5, 20)).toBe(0);
  });
});

describe('fileview/layout', () => {
  const folds = [
    { first: 2, last: 5 },
    { first: 9, last: 9 },
  ];

  it('collapses each fold into one item, rows keep their index', () => {
    const items = buildItems(12, folds, new Set());
    expect([...items.list]).toEqual([0, 1, ~0, 6, 7, 8, ~1, 10, 11]);
    expect(itemRows(items, 2)).toEqual({ first: 2, last: 5 });
    expect(itemRows(items, 3)).toEqual({ first: 6, last: 6 });
  });

  it('expanding a fold gives its rows back, the others stay collapsed', () => {
    const items = buildItems(12, folds, new Set([2]));
    expect([...items.list]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, ~1, 10, 11]);
    expect(buildItems(12, folds, new Set([2, 9])).list.length).toBe(12);
  });

  it('finds the item of a row, the fold that hides it included', () => {
    const items = buildItems(12, folds, new Set());
    expect(itemOfRow(items, 0)).toBe(0);
    expect(itemOfRow(items, 4)).toBe(2);
    expect(itemOfRow(items, 6)).toBe(3);
    expect(itemOfRow(items, 11)).toBe(8);
    expect(foldAt(items, 4)).toEqual({ first: 2, last: 5 });
    expect(foldAt(items, 6)).toBeNull();
  });

  it('opening a fold above keeps the top row where it was', () => {
    const items = buildItems(12, folds, new Set());
    // The viewport's top is 5px into row 7 (item 4).
    const anchor = anchorRow(items, 4 * 20 + 5, 20);
    expect(anchor).toEqual({ row: 7, offset: 5 });
    const opened = buildItems(12, folds, new Set([2]));
    expect(anchoredScroll(itemOfRow(opened, anchor.row), anchor.offset, 20)).toBe(7 * 20 + 5);
  });

  it('drops folds that are out of order, overlap or leave the rows', () => {
    expect(cleanSpans([{ first: 5, last: 8 }, { first: 1, last: 3 }, { first: 3, last: 4 }, { first: 9, last: 30 }, { first: -1, last: 2 }], 12)).toEqual([
      { first: 1, last: 3 },
      { first: 5, last: 8 },
    ]);
  });

  it('labels a fold with its line count', () => {
    expect(foldLabel({ first: 10, last: 29 })).toBe('20 unchanged lines');
    expect(foldLabel({ first: 4, last: 4 })).toBe('1 unchanged line');
  });

  it('measures the widest row and the largest line number', () => {
    const rows = [row('ctx', 1, 1, 'ab'), row('add', null, 120, 'abcdef'), row('del', 99, null)];
    expect(widestRow(rows)).toBe(6);
    expect(largestLine(rows)).toBe(120);
  });
});

describe('fileview/hunks', () => {
  const hunks = [
    { first: 3, last: 5 },
    { first: 20, last: 22 },
    { first: 40, last: 41 },
  ];

  it('walks the hunks and stays at the ends', () => {
    expect(stepHunk(-1, 3, 'next')).toBe(0);
    expect(stepHunk(-1, 3, 'prev')).toBe(2);
    expect(stepHunk(0, 3, 'next')).toBe(1);
    expect(stepHunk(2, 3, 'next')).toBe(2);
    expect(stepHunk(0, 3, 'prev')).toBe(0);
    expect(stepHunk(0, 0, 'next')).toBe(-1);
  });

  it('writes the counter as "2 / 7", and nothing without hunks', () => {
    expect(hunkCounter(1, 7)).toBe('2 / 7');
    expect(hunkCounter(0, 0)).toBe('');
  });

  it('starts at the hunk at or after a row, else the last', () => {
    expect(hunkFrom(hunks, 0)).toBe(0);
    expect(hunkFrom(hunks, 21)).toBe(1);
    expect(hunkFrom(hunks, 30)).toBe(2);
    expect(hunkFrom(hunks, 99)).toBe(2);
    expect(hunkFrom([], 3)).toBe(-1);
  });

  it('follows a reader: the last hunk that starts at or above the row', () => {
    expect(hunkAtRow(hunks, 0)).toBe(-1);
    expect(hunkAtRow(hunks, 3)).toBe(0);
    expect(hunkAtRow(hunks, 25)).toBe(1);
  });

  it('keeps only well-formed hunks', () => {
    expect(cleanHunks([{ first: 4, last: 2 }, { first: 1, last: 1 }], 10)).toEqual([{ first: 1, last: 1 }]);
  });
});

describe('fileview/range', () => {
  it('a click picks one line, Shift+click extends from it on the same side, in either direction', () => {
    const first = pickLine(null, 'new', 10, false);
    expect(first.range).toEqual({ side: 'new', start: 10, end: 10 });
    const down = pickLine(first, 'new', 14, true);
    expect(down.range).toEqual({ side: 'new', start: 10, end: 14 });
    const up = pickLine(down, 'new', 7, true);
    expect(up.range).toEqual({ side: 'new', start: 7, end: 10 });
  });

  it('Shift+click on the other side, or without a range, starts over', () => {
    const first = pickLine(null, 'new', 10, false);
    expect(pickLine(first, 'old', 3, true).range).toEqual({ side: 'old', start: 3, end: 3 });
    expect(pickLine(null, 'old', 5, true).range).toEqual({ side: 'old', start: 5, end: 5 });
    expect(pickLine(first, 'new', 30, false).range).toEqual({ side: 'new', start: 30, end: 30 });
  });

  it('knows which rows are in the range, by the side it is on', () => {
    const range = { side: 'new' as const, start: 2, end: 3 };
    expect(inRange(range, row('add', null, 2))).toBe(true);
    expect(inRange(range, row('del', 2, null))).toBe(false);
    expect(inRange(range, row('ctx', 9, 4))).toBe(false);
    expect(inRange(null, row('ctx', 1, 1))).toBe(false);
  });

  it('compares and describes ranges', () => {
    expect(sameRange({ side: 'old', start: 1, end: 2 }, { side: 'old', start: 1, end: 2 })).toBe(true);
    expect(sameRange({ side: 'old', start: 1, end: 2 }, null)).toBe(false);
    expect(describeRange({ side: 'new', start: 3, end: 5 })).toBe('new 3-5');
    expect(describeRange({ side: 'old', start: 7, end: 7 })).toBe('old 7');
  });
});

describe('fileview/segments', () => {
  it('cuts the text at the ranges and keeps the gaps plain', () => {
    expect(segments('const a = 1;', [[0, 5, 'kw'], [10, 11, 'num']])).toEqual([
      { text: 'const', cls: 'kw' },
      { text: ' a = ' },
      { text: '1', cls: 'num' },
      { text: ';' },
    ]);
  });

  it('is plain text without ranges and empty for an empty line', () => {
    expect(segments('x', undefined)).toEqual([{ text: 'x' }]);
    expect(segments('', undefined)).toEqual([]);
  });

  it('skips ranges that overlap, run backwards, name an unknown class, and clamps the end to the text', () => {
    const pieces = segments('abcdef', [[0, 3, 'kw'], [2, 4, 'str'], [5, 4, 'num'], [3, 5, 'nope' as 'kw'], [4, 99, 'fn']]);
    expect(pieces).toEqual([{ text: 'abc', cls: 'kw' }, { text: 'd' }, { text: 'ef', cls: 'fn' }]);
  });

  it('keeps markup as text and joins back to the original line', () => {
    const text = '<img src=x onerror=alert(1)> "q"';
    const pieces = segments(text, [[0, 4, 'punc']]);
    expect(pieces.map((piece) => piece.text).join('')).toBe(text);
  });

  it('maps each class to its own class name', () => {
    expect(hlClass('kw')).toBe('hl-kw');
    expect(hlClass('punc')).toBe('hl-punc');
  });
});

describe('fileview/spans', () => {
  const spans = [
    { id: 'f#Box', first: 0, last: 9 },
    { id: 'f#Box.open', first: 3, last: 5 },
    { id: 'f#other', first: 12, last: 13 },
  ];

  it('gives each row its innermost symbol', () => {
    const owner = owners(cleanSymbols(spans, 15), 15);
    expect([...owner]).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0, 0, -1, -1, 2, 2, -1]);
  });

  it('finds a span by id and drops spans outside the rows', () => {
    expect(spanOf(spans, 'f#other')).toEqual(spans[2]);
    expect(spanOf(spans, 'f#nope')).toBeNull();
    expect(spanOf(spans, null)).toBeNull();
    expect(cleanSymbols(spans, 10)).toHaveLength(2);
  });
});

describe('fileview/text', () => {
  it('formats sizes, new and deleted files, and stats', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MiB');
    expect(sizesLine({ before: 1024, after: null })).toBe('before 1.0 KiB, deleted');
    expect(sizesLine({ before: null, after: 10 })).toBe('new file, after 10 B');
    expect(statsLine({ added: 12, removed: 3 })).toBe('+12 −3 lines');
  });
});
