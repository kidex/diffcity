import { describe, expect, it } from 'vitest';
import { anchor, dedup, parseOwn, parseSarif } from '../../../src/core/findings/index.js';
import type { FindingInput, ParseResult } from '../../../src/core/findings/index.js';
import { shopfrontReport } from './support.js';

const ROOT = '/work/shopfront';

function own(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'claude',
    severity: 'high',
    category: 'security',
    file: 'src/auth/order.guard.ts',
    line: 14,
    title: 'Optional order defaults to allow',
    message: 'When order is undefined the guard returns true.',
    ...overrides,
  };
}

function sarifResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: 'shopfront.rule',
    level: 'error',
    message: { text: 'Something is wrong.' },
    locations: [{ physicalLocation: { artifactLocation: { uri: 'src/auth/order.guard.ts' }, region: { startLine: 14 } } }],
    ...overrides,
  };
}

function sarif(results: unknown[], name = 'semgrep'): unknown {
  return { version: '2.1.0', runs: [{ tool: { driver: { name } }, results }] };
}

function okFindings(result: ParseResult): FindingInput[] {
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.findings;
}

describe('findings', () => {
  it('own-valid', () => {
    const result = parseOwn(
      [own({ id: 'cr-1', fix: 'Return false.', why: 'new route', state: 'intended', category: 'architecture' }), own({ line: 3 })],
      ROOT,
    );
    expect(result).toEqual({
      ok: true,
      warnings: [],
      findings: [
        {
          id: 'cr-1',
          source: 'claude',
          severity: 'high',
          category: 'architecture',
          file: 'src/auth/order.guard.ts',
          line: 14,
          title: 'Optional order defaults to allow',
          message: 'When order is undefined the guard returns true.',
          fix: 'Return false.',
          why: 'new route',
          state: 'intended',
        },
        expect.objectContaining({ line: 3 }),
      ],
      sources: ['claude'],
    });
    // The distinct entry sources, in order of first appearance.
    const many = parseOwn([own({ source: 'semgrep' }), own(), own({ source: 'semgrep', line: 2 }), own({ source: 'eslint', file: '../x.ts' })], ROOT);
    expect(many.ok && many.sources).toEqual(['semgrep', 'claude', 'eslint']);
  });

  it('own-missing-field-rejected', () => {
    const noTitle = own();
    delete noTitle['title'];
    const result = parseOwn([own(), noTitle, own({ line: 0 }), own({ severity: 'critical' })], ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('findings[1].title: required');
    expect(result.errors).toContain('findings[2].line: must be an integer of 1 or more');
    expect(result.errors.some((e) => e.startsWith('findings[3].severity'))).toBe(true);
    expect(parseOwn({ not: 'an array' }, ROOT).ok).toBe(false);
  });

  it('own-path-traversal-skipped', () => {
    const result = parseOwn(
      [
        own({ file: '../outside/secret.ts' }),
        own({ file: 'src/../../etc/x.ts' }),
        own({ file: '/elsewhere/other.ts' }),
        own({ file: `${ROOT}/src/orders/orders.service.ts` }),
        own({ file: '.\\src\\util\\format.ts' }),
      ],
      ROOT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings.map((f) => f.file)).toEqual(['src/orders/orders.service.ts', 'src/util/format.ts']);
    expect(result.warnings.map((w) => w.at)).toEqual(['findings[0]', 'findings[1]', 'findings[2]']);
    expect(result.warnings[0]?.message).toBe('skipped: path "../outside/secret.ts" contains ".."');
    expect(result.warnings[2]?.message).toBe('skipped: absolute path "/elsewhere/other.ts" is outside the repository');
  });

  it('own-oversize-rejected', () => {
    const many = Array.from({ length: 5001 }, (_, i) => own({ line: i + 1 }));
    expect(parseOwn(many, ROOT).ok).toBe(false);
    expect(parseOwn(many.slice(0, 5000), ROOT).ok).toBe(true);
    expect(parseOwn([own({ message: 'x'.repeat(16 * 1024 + 1) })], ROOT).ok).toBe(false);
    expect(parseOwn([own({ message: 'x'.repeat(16 * 1024) })], ROOT).ok).toBe(true);
    expect(parseOwn([own({ title: 'x'.repeat(4097) })], ROOT).ok).toBe(false);
    expect(parseOwn([own({ fix: 'x'.repeat(4097) })], ROOT).ok).toBe(false);
  });

  it('sarif-level-mapping', () => {
    const results = ['error', 'warning', 'note', 'none', undefined].map((level, i) => sarifResult({ level, ruleId: `r${String(i)}` }));
    expect(okFindings(parseSarif(sarif(results), ROOT)).map((f) => f.severity)).toEqual(['high', 'med', 'low', 'low', 'low']);
    const one = okFindings(parseSarif(sarif([sarifResult({ fixes: [{ description: { text: 'Fix it.' } }] })]), ROOT))[0];
    expect(one).toMatchObject({
      source: 'semgrep',
      title: 'shopfront.rule',
      message: 'Something is wrong.',
      file: 'src/auth/order.guard.ts',
      line: 14,
      category: 'correctness',
      fix: 'Fix it.',
    });
    const noRule = okFindings(parseSarif(sarif([sarifResult({ ruleId: undefined })]), ROOT))[0];
    expect(noRule?.title).toBe('Something is wrong.');
  });

  it('sarif-no-location-skipped', () => {
    const result = parseSarif(
      sarif([
        sarifResult({ locations: [] }),
        sarifResult({ locations: undefined }),
        sarifResult({ locations: [{ logicalLocations: [{ name: 'x' }] }] }),
        sarifResult(),
      ]),
      ROOT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toEqual([
      { at: 'runs[0].results[0]', message: 'skipped: no physical location' },
      { at: 'runs[0].results[1]', message: 'skipped: no physical location' },
      { at: 'runs[0].results[2]', message: 'skipped: no physical location' },
    ]);
  });

  it('sarif-absolute-uri-made-relative', () => {
    const at = (uri: string): Record<string, unknown> =>
      sarifResult({ locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 2 } } }] });
    const result = parseSarif(
      sarif([
        at(`file://${ROOT}/src/orders/my%20file.ts`),
        at(`${ROOT}/src/util/format.ts`),
        at('file:///other/place.ts'),
        at('../up.ts'),
        at('src/orders/my%20file.ts'),
        at('src/%2E%2E/%2e%2e/up.ts'),
        at('src/orders/100%.ts'),
      ]),
      ROOT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A relative URI is percent-decoded too; one that is not valid percent-encoding is kept as written.
    expect(result.findings.map((f) => f.file)).toEqual(['src/orders/my file.ts', 'src/util/format.ts', 'src/orders/my file.ts', 'src/orders/100%.ts']);
    expect(result.warnings.map((w) => w.message)).toEqual([
      'skipped: absolute path "/other/place.ts" is outside the repository',
      'skipped: path "../up.ts" contains ".."',
      'skipped: path "src/../../up.ts" contains ".."',
    ]);
    // The own format takes `file` as a path, not a URI: no decoding.
    const own = parseOwn([{ source: 'claude', severity: 'low', category: 'style', file: 'src/a%20b.ts', line: 1, title: 't', message: 'm' }], ROOT);
    expect(own.ok && own.findings[0]?.file).toBe('src/a%20b.ts');
  });

  it('sarif-multiple-runs-sources', () => {
    const log = {
      version: '2.1.0',
      runs: [
        { tool: { driver: { name: 'semgrep' } }, results: [sarifResult()] },
        { tool: { driver: { name: 'eslint' } }, results: [sarifResult({ ruleId: 'no-guard' }), sarifResult({ ruleId: 'x' })] },
        { tool: { driver: {} }, results: [sarifResult()] },
      ],
    };
    expect(okFindings(parseSarif(log, ROOT)).map((f) => f.source)).toEqual(['semgrep', 'eslint', 'eslint', 'sarif']);
    // Every run is a source the import covers, also one whose results were all skipped or empty.
    const covered = parseSarif(
      {
        runs: [
          ...log.runs,
          { tool: { driver: { name: 'gitleaks' } }, results: [] },
          { tool: { driver: { name: 'semgrep' } }, results: [sarifResult({ locations: [] })] },
          { tool: { driver: { name: 'crashed' } } },
        ],
      },
      ROOT,
    );
    expect(covered.ok && covered.sources).toEqual(['semgrep', 'eslint', 'sarif', 'gitleaks']);
    // The same result from two tools becomes one entry that lists both.
    const twice = {
      version: '2.1.0',
      runs: ['semgrep', 'eslint'].map((name) => ({ tool: { driver: { name } }, results: [sarifResult({ ruleId: 'Guard allows all.' })] })),
    };
    const anchored = okFindings(parseSarif(twice, ROOT)).map((f) => {
      const r = anchor(f, shopfrontReport());
      if (!r.ok) throw new Error('anchor');
      return r.stored;
    });
    expect(dedup(anchored)).toHaveLength(1);
    expect(dedup(anchored)[0]?.finding.sources).toEqual(['semgrep', 'eslint']);
  });

  it('sarif-category-property', () => {
    const result = parseSarif(
      sarif([
        sarifResult({ properties: { category: 'architecture' } }),
        sarifResult({ properties: { category: 'tests' } }),
        sarifResult({ properties: { category: 'nonsense' } }),
      ]),
      ROOT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings.map((f) => f.category)).toEqual(['architecture', 'tests', 'correctness']);
    expect(result.warnings).toEqual([
      { at: 'runs[0].results[2]', message: 'unknown category "nonsense", "correctness" used' },
    ]);
  });
});
