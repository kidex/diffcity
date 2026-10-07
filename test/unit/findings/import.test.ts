// The import pipeline in src/core (ADR-036): reading a findings file (format
// detection, then parseOwn or parseSarif), checking a payload that arrives on
// the socket, and planning an import against a snapshot (anchor, merged and
// skipped counts, fixed keys).

import { describe, expect, it } from 'vitest';
import {
  anchor,
  checkImportPayload,
  detectFindingsFormat,
  parseFindingsText,
  planImport,
  type FindingInput,
  type StoredFinding,
} from '../../../src/core/findings/index.js';
import { shopfrontFingerprints, shopfrontReport } from './support.js';

const ROOT = '/work/shopfront';

const guardFinding = (over: Partial<FindingInput> = {}): FindingInput => ({
  source: 'claude',
  severity: 'high',
  category: 'security',
  file: 'src/auth/order.guard.ts',
  line: 14,
  title: 'Optional order defaults to allow',
  message: 'When order is undefined the guard returns true.',
  ...over,
});

function stored(input: FindingInput): StoredFinding {
  const result = anchor(input, shopfrontReport(), shopfrontFingerprints());
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

describe('detectFindingsFormat', () => {
  it('an array is the own format; $schema or version + runs is SARIF', () => {
    expect(detectFindingsFormat([])).toBe('own');
    expect(detectFindingsFormat({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [] })).toBe('sarif');
    expect(detectFindingsFormat({ version: '2.1.0', runs: [] })).toBe('sarif');
    expect(detectFindingsFormat({ runs: [] })).toBe('own');
    expect(detectFindingsFormat({ version: '2.1.0' })).toBe('own');
    expect(detectFindingsFormat('text')).toBe('own');
  });
});

describe('parseFindingsText', () => {
  it('parses the own format with the repo root', () => {
    const result = parseFindingsText(JSON.stringify([guardFinding({ file: `${ROOT}/src/auth/order.guard.ts` })]), ROOT);
    expect(result).toMatchObject({ ok: true, format: 'own', sources: ['claude'], findings: [{ file: 'src/auth/order.guard.ts' }] });
  });

  it('parses SARIF', () => {
    const sarif = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'semgrep' } },
          results: [{ ruleId: 'shopfront.no-unchecked-order', level: 'error', message: { text: 'Checked late.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/auth/order.guard.ts' }, region: { startLine: 12 } } }] }],
        },
        { tool: { driver: { name: 'eslint' } }, results: [] },
      ],
    };
    const result = parseFindingsText(JSON.stringify(sarif), ROOT);
    expect(result).toMatchObject({ ok: true, format: 'sarif', sources: ['semgrep', 'eslint'], findings: [{ source: 'semgrep', line: 12 }] });
  });

  it('absolute paths may use any spelling of the root; a leading byte order mark is ignored', () => {
    const own = [guardFinding({ file: '/logical/shopfront/src/auth/order.guard.ts' })];
    expect(parseFindingsText(JSON.stringify(own), [ROOT, '/logical/shopfront'])).toMatchObject({ ok: true, findings: [{ file: 'src/auth/order.guard.ts' }] });
    expect(parseFindingsText(JSON.stringify(own), ROOT)).toMatchObject({ ok: true, findings: [], warnings: [{ message: 'skipped: absolute path "/logical/shopfront/src/auth/order.guard.ts" is outside the repository' }] });
    expect(parseFindingsText(`\uFEFF${JSON.stringify([guardFinding()])}`, ROOT)).toMatchObject({ ok: true, format: 'own' });
  });

  it('invalid JSON and an invalid file are errors', () => {
    expect(parseFindingsText('{ not json', ROOT)).toEqual({ ok: false, errors: [expect.stringMatching(/^the file is not valid JSON/)] });
    expect(parseFindingsText('{"findings": []}', ROOT)).toEqual({ ok: false, errors: ['the file must be a JSON array of findings'] });
    const bad = parseFindingsText(JSON.stringify([{ ...guardFinding(), severity: 'urgent' }]), ROOT);
    expect(bad.ok).toBe(false);
  });
});

describe('checkImportPayload', () => {
  const payload = { findings: [guardFinding()], warnings: [{ at: 'findings[1]', message: 'skipped: empty path' }], sources: ['claude'] };

  it('accepts what the CLI sends', () => {
    expect(checkImportPayload(payload)).toEqual({ ok: true, payload });
  });

  it('sources are optional and default to the sources of the findings', () => {
    expect(checkImportPayload({ findings: [guardFinding()], warnings: [] })).toEqual({
      ok: true,
      payload: { findings: [guardFinding()], warnings: [], sources: ['claude'] },
    });
  });

  it('refuses a finding the parsers would never produce', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...payload, findings: 'x' }, /findings must be an array/],
      [{ ...payload, findings: [{ ...guardFinding(), severity: 'urgent' }] }, /findings\[0\]\.severity/],
      [{ ...payload, findings: [{ ...guardFinding(), line: 0 }] }, /findings\[0\]\.line/],
      [{ ...payload, findings: [{ ...guardFinding(), file: '../outside.ts' }] }, /findings\[0\]\.file/],
      [{ ...payload, findings: [{ ...guardFinding(), file: '/work/shopfront/a.ts' }] }, /findings\[0\]\.file/],
      [{ ...payload, findings: [{ ...guardFinding(), source: 'rule:size' }] }, /findings\[0\]\.source/],
      [{ ...payload, findings: [{ ...guardFinding(), title: 'x'.repeat(5000) }] }, /findings\[0\]\.title/],
      [{ ...payload, findings: [{ ...guardFinding(), state: 'gone' }] }, /findings\[0\]\.state/],
      [{ ...payload, findings: Array.from({ length: 5001 }, () => guardFinding()) }, /5000/],
      [{ ...payload, warnings: [{ at: 1, message: 'x' }] }, /warnings\[0\]/],
      [{ ...payload, sources: [3] }, /sources/],
    ];
    for (const [value, error] of cases) {
      const result = checkImportPayload(value);
      expect(result.ok, String(error)).toBe(false);
      if (!result.ok) expect(result.error).toMatch(error);
    }
  });
});

describe('planImport', () => {
  const report = shopfrontReport();
  const fingerprints = shopfrontFingerprints();

  it('anchors every finding in the change and counts the ones outside it as skipped, with a warning', () => {
    const plan = planImport({
      findings: [guardFinding(), guardFinding({ file: 'src/elsewhere.ts', line: 3 })],
      warnings: [{ at: 'findings[2]', message: 'skipped: path "../x.ts" contains ".."' }, { at: 'runs[0].results[1]', message: 'no region.startLine, line 1 used' }],
      sources: ['claude'],
      report,
      fingerprints,
      stored: [],
    });
    expect(plan.findings.map((entry) => entry.finding.symbolId)).toEqual(['src/auth/order.guard.ts#canCancel']);
    expect(plan).toMatchObject({ imported: 1, merged: 0, skipped: 2, fixed: [] });
    expect(plan.warnings).toEqual([
      { at: 'findings[2]', message: 'skipped: path "../x.ts" contains ".."' },
      { at: 'runs[0].results[1]', message: 'no region.startLine, line 1 used' },
      { at: 'src/elsewhere.ts:3', message: 'skipped-not-in-change: "src/elsewhere.ts" is not part of the change' },
    ]);
  });

  it('merged counts findings that collapse into an existing entry: same key, or same identity as a stored or earlier one', () => {
    const existing = stored(guardFinding());
    const plan = planImport({
      findings: [
        guardFinding(),
        guardFinding({ source: 'semgrep', line: 20 }),
        guardFinding({ file: 'src/orders/orders.service.ts', line: 12, title: 'Cancel skips the refund' }),
        guardFinding({ file: 'src/orders/orders.service.ts', line: 15, title: 'cancel skips the refund.' }),
      ],
      warnings: [],
      sources: ['claude', 'semgrep'],
      report,
      fingerprints,
      stored: [existing],
    });
    expect(plan).toMatchObject({ imported: 4, merged: 3, skipped: 0 });
  });

  it('fixed: a stored open finding of a covered source, not reported again, whose anchor changed', () => {
    const old = stored(guardFinding({ file: 'src/orders/orders.service.ts', line: 40, title: 'Refund twice', category: 'correctness' }));
    const moved = { ...old, anchor: { ...old.anchor, fingerprint: 'sym-refund-before' } };
    const plan = planImport({ findings: [guardFinding()], warnings: [], sources: ['claude'], report, fingerprints, stored: [moved] });
    expect(plan.fixed).toEqual([old.key]);
    const other = planImport({ findings: [], warnings: [], sources: ['semgrep'], report, fingerprints, stored: [moved] });
    expect(other.fixed).toEqual([]);
  });

  it('without fingerprints (a snapshot from before schema v2) nothing is fixed', () => {
    const old = stored(guardFinding({ title: 'Refund twice' }));
    const plan = planImport({ findings: [], warnings: [], sources: ['claude'], report, fingerprints: undefined, stored: [{ ...old, anchor: { ...old.anchor, fingerprint: 'x' } }] });
    expect(plan.fixed).toEqual([]);
  });
});
