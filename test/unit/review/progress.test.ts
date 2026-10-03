// Review progress and the rules of what can be marked (ADR-028).

import { describe, expect, it } from 'vitest';
import { computeProgress, markableTargets, validateMarkInput } from '../../../src/core/review/index.js';
import { publicMark, sampleFingerprints, sampleReport, storedMark } from './review-helpers.js';

const fingerprints = sampleFingerprints();
const marks = (...list: ReturnType<typeof storedMark>[]) => list.map(publicMark);

describe('review/progress-file-mark', () => {
  it('a current file mark makes the file done; attention counts eyes and risky files only', () => {
    const progress = computeProgress(sampleReport(), marks(storedMark(fingerprints, 'file', 'f-total', { mark: 'good' })));
    expect(progress).toEqual({
      attention: { done: 1, total: 1 },
      touched: { done: 1, total: 2 },
      rewrite: 0,
      outdated: 0,
      allAttentionDone: true,
    });
  });

  it('nothing marked: nothing done, allAttentionDone false', () => {
    const progress = computeProgress(sampleReport(), []);
    expect(progress.attention).toEqual({ done: 0, total: 1 });
    expect(progress.touched).toEqual({ done: 0, total: 2 });
    expect(progress.allAttentionDone).toBe(false);
  });

  it('no attention files at all: allAttentionDone stays false', () => {
    const report = sampleReport();
    const target = report.packages[0]?.files[0];
    if (target === undefined) throw new Error('fixture');
    target.verdict = 'ok';
    expect(computeProgress(report, []).allAttentionDone).toBe(false);
  });
});

describe('review/progress-all-symbols-marked', () => {
  it('a file is done when every changed symbol has a current mark; unchanged symbols are not needed', () => {
    const partial = computeProgress(sampleReport(), marks(storedMark(fingerprints, 'symbol', 's-total')));
    expect(partial.attention.done).toBe(0);
    const all = computeProgress(
      sampleReport(),
      marks(
        storedMark(fingerprints, 'symbol', 's-total'),
        storedMark(fingerprints, 'symbol', 's-round', { mark: 'rewrite', note: 'redo' }),
      ),
    );
    expect(all.attention).toEqual({ done: 1, total: 1 });
    expect(all.touched).toEqual({ done: 1, total: 2 });
    expect(all.rewrite).toBe(1);
  });
});

describe('review/progress-outdated-not-counted', () => {
  it('an outdated mark counts as unchecked and is reported in outdated', () => {
    const progress = computeProgress(
      sampleReport(),
      marks(
        storedMark(fingerprints, 'file', 'f-total', { state: 'outdated', outdatedAt: '2026-09-01T11:00:00.000Z' }),
        storedMark(fingerprints, 'file', 'f-tax', { mark: 'rewrite', note: 'x', state: 'outdated' }),
      ),
    );
    expect(progress.attention.done).toBe(0);
    expect(progress.touched.done).toBe(0);
    expect(progress.outdated).toBe(2);
    expect(progress.rewrite).toBe(0);
  });
});

describe('review/rewrite-needs-note', () => {
  const body = (extra: Record<string, unknown>) => ({ snapshotId: 3, target: { kind: 'file', id: 'f-total' }, mark: 'rewrite', ...extra });

  it('a rewrite mark without a note, with an empty or blank note, or with a note over 2000 characters is rejected', () => {
    for (const bad of [body({}), body({ note: '' }), body({ note: '   ' }), body({ note: 'x'.repeat(2001) })]) {
      expect(validateMarkInput(bad).ok).toBe(false);
    }
  });

  it('a rewrite mark with a note and a line range is accepted; checked and good need none', () => {
    const rewrite = validateMarkInput(body({ note: 'rename it', lines: { side: 'new', start: 4, end: 9 } }));
    expect(rewrite).toEqual({
      ok: true,
      value: { snapshotId: 3, target: { kind: 'file', id: 'f-total' }, mark: 'rewrite', note: 'rename it', lines: { side: 'new', start: 4, end: 9 } },
    });
    expect(validateMarkInput({ snapshotId: 3, target: { kind: 'symbol', id: 's' }, mark: 'good' }).ok).toBe(true);
    expect(validateMarkInput(body({ note: 'x'.repeat(2000) })).ok).toBe(true);
  });

  it('rejects a bad body, mark, target or line range', () => {
    const base = { snapshotId: 3, target: { kind: 'file', id: 'f' }, mark: 'good' };
    for (const bad of [
      null,
      [],
      { ...base, snapshotId: 0 },
      { ...base, snapshotId: '3' },
      { ...base, mark: 'great' },
      { ...base, target: { kind: 'package', id: 'f' } },
      { ...base, target: { kind: 'file', id: '' } },
      { ...base, lines: { side: 'new', start: 0, end: 2 } },
      { ...base, lines: { side: 'new', start: 5, end: 2 } },
      { ...base, lines: { side: 'middle', start: 1, end: 2 } },
    ]) {
      expect(validateMarkInput(bad).ok).toBe(false);
    }
  });
});

describe('review/untouched-file-not-markable', () => {
  it('touched files and every symbol of them are markable; an untouched file and its symbols are not', () => {
    const targets = markableTargets(sampleReport(), fingerprints);
    expect([...targets.keys()].sort()).toEqual(['file:f-tax', 'file:f-total', 'symbol:s-rate', 'symbol:s-round', 'symbol:s-total']);
    expect(targets.has('file:f-readme')).toBe(false);
    expect(targets.has('symbol:s-banner')).toBe(false);
  });

  it('a target without a fingerprint entry is not markable', () => {
    const partial = sampleFingerprints();
    delete partial.symbols['s-round'];
    expect(markableTargets(sampleReport(), partial).has('symbol:s-round')).toBe(false);
  });
});
