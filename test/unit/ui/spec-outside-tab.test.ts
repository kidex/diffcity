// spec/outside-spec-tab-counts (SPEC.md 5.5, ADR-035): the Outside the spec
// tab counts and lists the files the Report says are outside the spec
// (`inSpec === false`), whatever their verdict, and shows the Report's
// notice when the spec marks nothing. Rendering only: the Report decides.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Report } from '../../../src/core/report/types.js';
import { counters, outsideSpec } from '../../../src/ui/screens/change/model/panel.js';

const golden = (): Report =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/scenarios/spec-scope/expected.json'), 'utf8')) as Report;

describe('spec/outside-spec-tab-counts', () => {
  it('the spec-scope golden: one file outside the spec, counted and listed', () => {
    const report = golden();
    expect(counters(report).outside).toBe(1);
    expect(outsideSpec(report)).toMatchObject({ specKnown: true, notice: null });
    expect(outsideSpec(report).files.map((placed) => placed.file.path)).toEqual(['src/catalog/banner.ts']);
    expect(report.summary.byVerdict.spec).toBe(1);
  });

  it('a file outside the spec with an earlier verdict (eyes) is in the tab too, while byVerdict.spec counts only spec verdicts', () => {
    const report = golden();
    const refund = report.packages.flatMap((pkg) => pkg.files).find((file) => file.path === 'src/orders/refund.ts');
    if (refund === undefined) throw new Error('src/orders/refund.ts is missing from the golden');
    refund.inSpec = false;
    expect(refund.verdict).toBe('eyes');
    expect(counters(report).outside).toBe(2);
    expect(outsideSpec(report).files.map((placed) => placed.file.path)).toEqual(['src/catalog/banner.ts', 'src/orders/refund.ts']);
    expect(report.summary.byVerdict.spec).toBe(1);
  });

  it('a spec that names nothing touched: zero in the tab and the notice of the Report', () => {
    const report = golden();
    for (const file of report.packages.flatMap((pkg) => pkg.files)) file.inSpec = null;
    report.specNotice = 'The spec names no touched symbol or file';
    expect(counters(report).outside).toBe(0);
    expect(outsideSpec(report)).toEqual({ files: [], specKnown: false, notice: 'The spec names no touched symbol or file' });
  });
});
