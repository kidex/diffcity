// Highlight ranges are untrusted input from the daemon (ADR-027): whatever
// they hold, a row renders its whole text and only whitelisted classes.

import { describe, expect, it } from 'vitest';
import type { DiffRow } from '../../../src/core/model/types.js';
import { segments } from '../../../src/ui/screens/change/panel/fileview/segments.js';

const WHITELIST = ['kw', 'str', 'num', 'com', 'type', 'fn', 'prop', 'op', 'punc', 'var'];
const joined = (text: string, hl: unknown): string => segments(text, hl as DiffRow['hl']).map((piece) => piece.text).join('');

describe('fileview/hl-surrogate-pairs', () => {
  const text = 'const s = "🍞🥐 bake 𝒳"; // 😀';

  it('keeps the whole text when ranges start, end or split inside an astral character', () => {
    const emoji = text.indexOf('🍞');
    const cuts: [number, number, string][][] = [
      [[emoji, emoji + 2, 'str']],
      [[emoji + 1, emoji + 3, 'str']],
      [[emoji, emoji + 1, 'str'], [emoji + 1, emoji + 4, 'num']],
      [[0, 5, 'kw'], [emoji - 1, emoji + 5, 'str'], [text.length - 1, text.length, 'com']],
      [[0, text.length, 'com']],
    ];
    for (const hl of cuts) {
      expect(() => segments(text, hl as DiffRow['hl'])).not.toThrow();
      expect(joined(text, hl)).toBe(text);
    }
  });

  it('a row that is only emoji survives ranges at every UTF-16 column', () => {
    const only = '😀😀😀';
    for (let start = 0; start <= only.length; start++) {
      for (let end = start; end <= only.length + 1; end++) {
        expect(joined(only, [[start, end, 'str']])).toBe(only);
      }
    }
  });
});

describe('fileview/hl-malformed', () => {
  const text = 'let value = compute(1, "two");';

  it('never throws, keeps the text and uses only whitelisted classes', () => {
    const hl = [
      null,
      undefined,
      'kw',
      42,
      [],
      [0],
      [-5, 3, 'kw'],
      [8, 4, 'str'],
      [2, 9, 'num'],
      [4, 12, 'fn'],
      [5, 9999, 'var'],
      [1000, 2000, 'op'],
      [0, 3, 'bogus'],
      [0, 3, '__proto__'],
      [0, 3, undefined],
      [0.5, 2.5, 'kw'],
      [Number.NaN, 3, 'kw'],
      [0, Number.POSITIVE_INFINITY, 'kw'],
      ['0', '3', 'kw'],
    ];
    expect(() => segments(text, hl as unknown as DiffRow['hl'])).not.toThrow();
    expect(joined(text, hl)).toBe(text);
    for (const piece of segments(text, hl as unknown as DiffRow['hl'])) {
      if (piece.cls !== undefined) expect(WHITELIST).toContain(piece.cls);
    }
  });

  it('a negative start is clamped and a reversed or beyond-length range is dropped', () => {
    expect(segments('abcdef', [[-5, 3, 'kw']])).toEqual([{ text: 'abc', cls: 'kw' }, { text: 'def' }]);
    expect(segments('abcdef', [[4, 2, 'kw']])).toEqual([{ text: 'abcdef' }]);
    expect(segments('abcdef', [[10, 20, 'kw']])).toEqual([{ text: 'abcdef' }]);
  });

  it('overlapping ranges: the earlier wins and the text is not duplicated', () => {
    expect(segments('abcdef', [[0, 4, 'kw'], [2, 6, 'str']])).toEqual([{ text: 'abcd', cls: 'kw' }, { text: 'ef' }]);
  });
});
