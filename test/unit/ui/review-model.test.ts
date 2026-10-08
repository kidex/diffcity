// review-ui/* (ADR-028, T10): the pure side of the review marks on the change
// screen: marks mapped to what the scene draws, the note check, targets, the
// optimistic copy and its rollback, the progress wording and the tooltip line.

import { describe, expect, it } from 'vitest';
import type { ReviewMark } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import {
  ALL_CHECKED,
  markOf,
  marksOf,
  markTip,
  noteProblem,
  NOTE_MAX,
  OUTDATED_HINT,
  progressView,
  restored,
  targetFor,
  tipMark,
  withMark,
  withoutMark,
} from '../../../src/ui/screens/change/model/review.js';
import type { ReviewState } from '../../../src/ui/screens/change/ports.js';

const mark = (over: Partial<ReviewMark>): ReviewMark => ({
  targetKind: 'file',
  targetId: 'src/a.ts',
  filePath: 'src/a.ts',
  mark: 'checked',
  note: null,
  lines: null,
  state: 'current',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  outdatedAt: null,
  ...over,
});

const progress = { attention: { done: 1, total: 3 }, touched: { done: 2, total: 5 }, tier1: { done: 0, total: 0 }, rewrite: 1, outdated: 0, allAttentionDone: false };
const state = (marks: ReviewMark[]): ReviewState => ({ snapshotId: 4, marks, note: null, progress });

const report = {
  packages: [
    {
      id: 'src',
      path: 'src',
      tier1: false,
      files: [
        { id: 'src/a.ts', path: 'src/a.ts', language: 'typescript', status: 'mod', verdict: 'eyes', inSpec: null, symbols: [{ id: 'src/a.ts#f', name: 'f', kind: 'function', status: 'mod', range: { start: 1, end: 3 } }] },
        { id: 'src/b.ts', path: 'src/b.ts', language: 'typescript', status: 'same', verdict: 'same', inSpec: null, symbols: [] },
      ],
    },
  ],
} as unknown as Report;

describe('review-ui', () => {
  it('review-ui/marks-map-to-the-scene: current marks keep their value, an outdated one reads outdated, files and symbols apart', () => {
    const marks = marksOf(
      state([mark({}), mark({ targetKind: 'symbol', targetId: 'src/a.ts#f', mark: 'rewrite', note: 'x' }), mark({ targetId: 'src/c.ts', mark: 'good', state: 'outdated' })]),
    );
    expect(Object.fromEntries(marks?.files ?? [])).toEqual({ 'src/a.ts': 'checked', 'src/c.ts': 'outdated' });
    expect(Object.fromEntries(marks?.symbols ?? [])).toEqual({ 'src/a.ts#f': 'rewrite' });
    expect(marksOf(null)).toBeUndefined();
  });

  it('review-ui/note-1-to-2000: an empty or blank note and one past 2,000 characters are refused', () => {
    expect(noteProblem('')).not.toBeNull();
    expect(noteProblem('   \n ')).not.toBeNull();
    expect(noteProblem('x')).toBeNull();
    expect(noteProblem('x'.repeat(NOTE_MAX))).toBeNull();
    expect(noteProblem('x'.repeat(NOTE_MAX + 1))).toMatch(/1 characters too long/);
  });

  it('review-ui/target: the focused floor, else the file; the whole file on request; untouched and unknown files have none', () => {
    expect(targetFor(report, 'src/a.ts', 'src/a.ts#f')).toMatchObject({ target: { kind: 'symbol', id: 'src/a.ts#f' }, symbol: true, label: 'f' });
    expect(targetFor(report, 'src/a.ts', null)).toMatchObject({ target: { kind: 'file', id: 'src/a.ts' }, symbol: false, floor: null });
    expect(targetFor(report, 'src/a.ts', 'src/a.ts#f', true)).toMatchObject({ target: { kind: 'file', id: 'src/a.ts' }, floor: { id: 'src/a.ts#f', name: 'f' } });
    // A symbol the file does not have falls back to the file.
    expect(targetFor(report, 'src/a.ts', 'src/a.ts#gone')?.target).toEqual({ kind: 'file', id: 'src/a.ts' });
    expect(targetFor(report, 'src/b.ts', null)).toBeNull();
    expect(targetFor(report, 'src/none.ts', null)).toBeNull();
  });

  it('review-ui/optimistic-and-rollback: a mark replaces the target\'s own, undo removes it, a failed write puts the old one back', () => {
    const before = mark({ mark: 'good' });
    const start = state([before, mark({ targetId: 'src/z.ts' })]);
    const next = withMark(start, { snapshotId: 4, target: { kind: 'file', id: 'src/a.ts' }, mark: 'rewrite', note: 'redo' }, 'src/a.ts', '2026-02-02T00:00:00.000Z');
    expect(next.marks).toHaveLength(2);
    expect(markOf(next, { kind: 'file', id: 'src/a.ts' })).toMatchObject({ mark: 'rewrite', note: 'redo', state: 'current', createdAt: before.createdAt, updatedAt: '2026-02-02T00:00:00.000Z' });
    // The daemon's progress is not guessed.
    expect(next.progress).toBe(start.progress);
    expect(withoutMark(next, { kind: 'file', id: 'src/a.ts' }).marks.map((m) => m.targetId)).toEqual(['src/z.ts']);
    expect(markOf(restored(next, { kind: 'file', id: 'src/a.ts' }, before), { kind: 'file', id: 'src/a.ts' })).toBe(before);
    expect(markOf(restored(next, { kind: 'file', id: 'src/a.ts' }, undefined), { kind: 'file', id: 'src/a.ts' })).toBeUndefined();
  });

  it('review-ui/progress-wording: N of M, everything done, nothing needing eyes, the touched, rewrite and stale counts', () => {
    expect(progressView(progress)).toMatchObject({ headline: '1 of 3 files that need your eyes checked', done: false, touched: '2 of 5 touched files checked', rewrite: '1 to rewrite', outdated: null });
    const done = progressView({ ...progress, attention: { done: 3, total: 3 }, allAttentionDone: true, outdated: 2 });
    expect(done).toMatchObject({ headline: ALL_CHECKED, done: true, outdated: '2 changed since you checked them' });
    expect(ALL_CHECKED).toBe('Everything that needs your eyes is checked');
    expect(progressView({ ...progress, attention: { done: 0, total: 0 } }).headline).toBe('No files need your eyes');
    expect(progressView({ ...progress, outdated: 1 }).outdated).toBe('1 changed since you checked it');
  });

  it('review-ui/tooltip-line: the floor\'s own mark, else the file\'s; outdated says it changed; the note travels', () => {
    const s = state([mark({ mark: 'good' }), mark({ targetKind: 'symbol', targetId: 'src/a.ts#f', mark: 'rewrite', note: 'redo', state: 'outdated' })]);
    expect(tipMark(s, 'src/a.ts', 'src/a.ts#f')).toEqual({ label: 'Needs rewrite', mark: 'rewrite', hint: OUTDATED_HINT, note: 'redo' });
    expect(tipMark(s, 'src/a.ts', 'src/a.ts#other')).toEqual({ label: 'Looks good', mark: 'good', hint: null, note: null });
    expect(tipMark(s, 'src/q.ts', null)).toBeNull();
    expect(tipMark(null, 'src/a.ts', null)).toBeNull();
    expect(markTip(undefined)).toBeNull();
  });
});
