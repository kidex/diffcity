// `diffcity diff --json --compact` (ADR-037): an output filter in the CLI that
// leaves out untouched files and the packages left with none. buildReport is
// unchanged; meta, steps, findings, checks and summary pass through as they are.

import { describe, expect, it } from 'vitest';
import { compactReport, formatSummary, runDiff, type DiffCommandOptions } from '../../../src/cli/diff.js';
import type { File, Report } from '../../../src/core/report/types.js';

const file = (path: string, status: File['status']): File => ({
  id: path,
  path,
  language: 'typescript',
  status,
  verdict: status === 'same' ? 'same' : 'eyes',
  inSpec: null,
  symbols: [{ id: `${path}#main`, name: 'main', kind: 'function', status, range: { start: 1, end: 4 } }],
});

const report: Report = {
  meta: { repo: 'sample-bakery', base: 'main', head: 'feature/rolls', commits: 2, generatedAt: '2026-03-04T05:06:07.000Z' },
  packages: [
    { id: 'src/billing', path: 'src/billing', tier1: true, files: [file('src/billing/rates.ts', 'mod'), file('src/billing/tax.ts', 'same')] },
    { id: 'src/kitchen', path: 'src/kitchen', tier1: false, files: [file('src/kitchen/oven.ts', 'same'), file('src/kitchen/tray.ts', 'same')] },
    { id: 'src/menu', path: 'src/menu', tier1: false, files: [file('src/menu/dish.ts', 'add'), file('src/menu/old.ts', 'del'), file('src/menu/card.ts', 'sig')] },
  ],
  steps: [
    { order: 1, symbolId: 'src/menu/dish.ts#main', fileId: 'src/menu/dish.ts', why: 'New function', diff: [{ kind: 'add', text: 'export function main() {}' }], section: 'unconnected' },
  ],
  findings: [
    { id: 'f:0123456789abcdef', source: 'claude', sources: ['claude'], severity: 'high', category: 'correctness', file: 'src/billing/rates.ts', line: 2, title: 'Rate rounds down', message: 'An invented finding.', state: 'open' },
  ],
  checks: [{ ruleId: 'file-size', kind: 'file-size', state: 'passed', findings: 0, checkedAt: '2026-03-04T05:06:07.000Z' }],
  summary: {
    files: 7,
    byStatus: { add: 1, mod: 1, sig: 1, del: 1, same: 3 },
    byVerdict: { eyes: 4, risky: 0, spec: 0, ok: 0, same: 3 },
    tier1Files: ['src/billing/rates.ts'],
  },
};

async function run(options: DiffCommandOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = { stdout: '', stderr: '' };
  const code = await runDiff(options, {
    cwd: '/work/sample-bakery',
    io: { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    build: () => Promise.resolve(structuredClone(report)),
  });
  return { code, ...out };
}

describe('diffcity diff --json --compact (ADR-037)', () => {
  it('compact/drops-untouched-files: untouched files go, and so does a package left without files', async () => {
    const result = await run({ json: true, compact: true });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    const compact = JSON.parse(result.stdout) as Report;
    expect(compact.packages.map((pkg) => [pkg.id, pkg.files.map((entry) => entry.path)])).toEqual([
      ['src/billing', ['src/billing/rates.ts']],
      ['src/menu', ['src/menu/dish.ts', 'src/menu/old.ts', 'src/menu/card.ts']],
    ]);
    // A kept file is kept whole, with its symbols and verdict.
    expect(compact.packages[0]?.files[0]).toEqual(file('src/billing/rates.ts', 'mod'));
    expect(compact.packages[0]).toMatchObject({ path: 'src/billing', tier1: true });
  });

  it('compact/keeps-steps-findings-checks-summary: meta, steps, findings, checks and summary are unchanged', async () => {
    const compact = JSON.parse((await run({ json: true, compact: true })).stdout) as Report;
    expect(compact.meta).toEqual(report.meta);
    expect(compact.steps).toEqual(report.steps);
    expect(compact.findings).toEqual(report.findings);
    expect(compact.checks).toEqual(report.checks);
    // The summary still counts the whole change, untouched files included.
    expect(compact.summary).toEqual(report.summary);
    expect(Object.keys(compact)).toEqual(Object.keys(report));
  });

  it('compact/no-effect-without-json: --compact alone prints the same summary as without it', async () => {
    const plain = await run({});
    const compact = await run({ compact: true });
    expect(compact).toEqual(plain);
    expect(compact.stdout).toBe(formatSummary(report));
  });

  it('--json without --compact still prints every file', async () => {
    const full = JSON.parse((await run({ json: true })).stdout) as Report;
    expect(full).toEqual(report);
  });

  it('compactReport leaves its input untouched', () => {
    const input = structuredClone(report);
    compactReport(input);
    expect(input).toEqual(report);
  });
});
