import { describe, expect, it } from 'vitest';
import { assembleReport, packagePathOf, type ReportFileInput } from '../../src/core/report/index.js';
import type { Report } from '../../src/core/report/types.js';

const meta: Report['meta'] = {
  repo: 'sample-bakery',
  base: 'main',
  head: 'feature/rolls',
  commits: 2,
  generatedAt: '2026-03-04T05:06:07.000Z',
};

const never = (): boolean => false;

describe('packagePathOf (ADR-011)', () => {
  it.each([
    ['index.ts', '.'],
    ['src/oven.ts', 'src'],
    ['src/kitchen/oven/door.ts', 'src/kitchen/oven'],
    ['.github/workflow.yml', '.github'],
  ])('%s is in package %s', (path, expected) => {
    expect(packagePathOf(path)).toBe(expected);
  });
});

describe('assembleReport', () => {
  it('an empty change still has every summary key at zero', () => {
    expect(assembleReport(meta, [], never)).toEqual({
      meta,
      packages: [],
      steps: [],
      findings: [],
      summary: {
        files: 0,
        byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 },
        byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 },
        tier1Files: [],
      },
    });
  });

  it('does not depend on the input order', () => {
    const inputs: ReportFileInput[] = [
      { path: 'src/b.ts', language: 'typescript', status: 'mod', symbols: [] },
      { path: 'a.md', language: 'other', status: 'add', symbols: [] },
      { path: 'src/a.ts', language: 'typescript', status: 'same', symbols: [] },
    ];
    const forward = JSON.stringify(assembleReport(meta, inputs, never));
    const backward = JSON.stringify(assembleReport(meta, [...inputs].reverse(), never));
    expect(backward).toBe(forward);
  });

  it('an untouched tier 1 file is same and stays out of tier1Files; its package is still tier 1', () => {
    const report = assembleReport(
      meta,
      [{ path: 'src/billing/tax.ts', language: 'typescript', status: 'same', symbols: [] }],
      (path) => path.includes('billing'),
    );
    expect(report.packages[0]).toMatchObject({ path: 'src/billing', tier1: true });
    expect(report.packages[0]?.files[0]?.verdict).toBe('same');
    expect(report.summary.tier1Files).toEqual([]);
  });
});
