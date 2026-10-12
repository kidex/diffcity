// The Approve gate (ADR-036): every touched tier 1 file needs a current mark,
// on the file or on each of its changed symbols; an outdated mark does not count.

import { describe, expect, it } from 'vitest';
import { checkRemainingPlan, uncheckedTier1Files } from '../../../src/core/review/index.js';
import type { Report } from '../../../src/core/report/types.js';
import { publicMark, sampleFingerprints, sampleReport, storedMark } from './review-helpers.js';

/** The sample report with src/cart/total.ts (symbols total, roundCents) as its tier 1 file. */
function tier1Report(): Report {
  const report = sampleReport();
  return { ...report, summary: { ...report.summary, tier1Files: ['src/cart/total.ts'] } };
}

const fp = sampleFingerprints();

describe('approve gate', () => {
  it('no tier 1 file: nothing blocks', () => {
    expect(uncheckedTier1Files(sampleReport(), [])).toEqual([]);
  });

  it('an unmarked tier 1 file blocks; a mark on another file does not help', () => {
    expect(uncheckedTier1Files(tier1Report(), [publicMark(storedMark(fp, 'file', 'f-tax'))])).toEqual(['src/cart/total.ts']);
  });

  it('a current file mark of any kind checks the file', () => {
    for (const mark of ['checked', 'good', 'rewrite'] as const) {
      const marks = [publicMark(storedMark(fp, 'file', 'f-total', { mark, note: mark === 'rewrite' ? 'split' : null }))];
      expect(uncheckedTier1Files(tier1Report(), marks)).toEqual([]);
    }
  });

  it('marks on every changed symbol check the file; one symbol is not enough', () => {
    const one = [publicMark(storedMark(fp, 'symbol', 's-total'))];
    expect(uncheckedTier1Files(tier1Report(), one)).toEqual(['src/cart/total.ts']);
    const both = [...one, publicMark(storedMark(fp, 'symbol', 's-round'))];
    expect(uncheckedTier1Files(tier1Report(), both)).toEqual([]);
  });

  it('an outdated mark counts as unchecked', () => {
    const marks = [publicMark(storedMark(fp, 'file', 'f-total', { state: 'outdated', outdatedAt: '2026-09-02T00:00:00.000Z' }))];
    expect(uncheckedTier1Files(tier1Report(), marks)).toEqual(['src/cart/total.ts']);
  });

  it('a tier 1 path missing from the packages blocks', () => {
    const report = tier1Report();
    report.summary.tier1Files = ['src/auth/session.ts'];
    expect(uncheckedTier1Files(report, [])).toEqual(['src/auth/session.ts']);
  });
});

describe('check the rest (ADR-028 amendment)', () => {
  /** total.ts and tax.ts both tier 1. */
  function twoTier1(): Report {
    const report = sampleReport();
    return { ...report, summary: { ...report.summary, tier1Files: ['src/cart/total.ts', 'src/cart/tax.ts'] } };
  }

  it('plans a Checked file mark, with the current fingerprint, for each tier 1 file without a current mark', () => {
    const plan = checkRemainingPlan(twoTier1(), fp, []);
    expect(plan).toEqual({
      files: ['src/cart/total.ts', 'src/cart/tax.ts'],
      marks: [
        { target: { kind: 'file', id: 'f-total' }, filePath: 'src/cart/total.ts', fingerprint: 'b-total|a-total' },
        { target: { kind: 'file', id: 'f-tax' }, filePath: 'src/cart/tax.ts', fingerprint: 'b-tax|a-tax' },
      ],
      unmarkable: [],
    });
  });

  it('leaves files that already count as checked: a current file mark, or marks on every changed symbol', () => {
    const fileMark = [publicMark(storedMark(fp, 'file', 'f-tax', { mark: 'rewrite', note: null }))];
    expect(checkRemainingPlan(twoTier1(), fp, fileMark).files).toEqual(['src/cart/total.ts']);
    const symbols = [publicMark(storedMark(fp, 'symbol', 's-total')), publicMark(storedMark(fp, 'symbol', 's-round'))];
    expect(checkRemainingPlan(twoTier1(), fp, symbols).marks.map((m) => m.target.id)).toEqual(['f-tax']);
  });

  it('an outdated mark is replaced; a partial symbol review still gets the file mark', () => {
    const marks = [
      publicMark(storedMark(fp, 'file', 'f-total', { state: 'outdated', outdatedAt: '2026-09-02T00:00:00.000Z' })),
      publicMark(storedMark(fp, 'symbol', 's-rate', { state: 'outdated', outdatedAt: '2026-09-02T00:00:00.000Z' })),
    ];
    expect(checkRemainingPlan(twoTier1(), fp, marks).marks.map((m) => m.target.id)).toEqual(['f-total', 'f-tax']);
  });

  it('a tier 1 path that is not a markable file (missing from the Report or without a fingerprint) is unmarkable', () => {
    const report = twoTier1();
    report.summary.tier1Files = ['src/auth/session.ts', 'src/cart/tax.ts', 'src/cart/total.ts'];
    const noTax = sampleFingerprints();
    delete noTax.files['f-tax'];
    const plan = checkRemainingPlan(report, noTax, []);
    expect(plan.files).toEqual(['src/auth/session.ts', 'src/cart/tax.ts', 'src/cart/total.ts']);
    expect(plan.marks.map((m) => m.target.id)).toEqual(['f-total']);
    expect(plan.unmarkable).toEqual(['src/auth/session.ts', 'src/cart/tax.ts']);
  });

  it('nothing remaining: an empty plan', () => {
    expect(checkRemainingPlan(sampleReport(), fp, [])).toEqual({ files: [], marks: [], unmarkable: [] });
  });
});
