// The in-memory line diff behind Step.diff (src/core/diff/lines.ts).

import { describe, expect, it } from 'vitest';
import { diffLines, type LineOp } from '../../src/core/diff/lines.js';

const sides = (ops: readonly LineOp[]): { before: string[]; after: string[] } => ({
  before: ops.filter((op) => op.kind !== 'add').map((op) => op.text),
  after: ops.filter((op) => op.kind !== 'del').map((op) => op.text),
});

/** A small deterministic generator, so the cases are the same on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('diffLines', () => {
  it('lines/identical-and-empty: identical sides are all context; one empty side is all add or all del', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
    ]);
    expect(diffLines([], ['a'])).toEqual([{ kind: 'add', text: 'a' }]);
    expect(diffLines(['a'], [])).toEqual([{ kind: 'del', text: 'a' }]);
  });

  it('lines/minimal-edit: one changed line is one del then one add, the rest context', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'ctx', text: 'c' },
    ]);
    const ops = diffLines(['a', 'b', 'c', 'd'], ['b', 'c', 'e', 'd']);
    expect(ops.filter((op) => op.kind !== 'ctx')).toEqual([
      { kind: 'del', text: 'a' },
      { kind: 'add', text: 'e' },
    ]);
  });

  it('lines/reconstructs-both-sides: on random inputs the script rebuilds before and after exactly', () => {
    const random = lcg(97);
    for (let round = 0; round < 200; round++) {
      const pick = (): string[] => Array.from({ length: Math.floor(random() * 30) }, () => 'abcdef'[Math.floor(random() * 6)] ?? 'a');
      const before = pick();
      const after = pick();
      expect(sides(diffLines(before, after))).toEqual({ before, after });
      // Past the edit limit the middle is removed then added: still both sides.
      expect(sides(diffLines(before, after, 2))).toEqual({ before, after });
    }
  });
});
