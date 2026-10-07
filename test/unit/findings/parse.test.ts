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
    // `why` is capped at 4 KiB of UTF-8, like title (a 2-byte character counts twice).
    expect(parseOwn([own({ why: 'x'.repeat(4096) })], ROOT).ok).toBe(true);
    expect(parseOwn([own({ why: 'é'.repeat(2049) })], ROOT)).toEqual({ ok: false, errors: ['findings[0]: why is over 4096 bytes'] });
    // It is a one-line hint: newlines and whitespace runs collapse to single spaces.
    const hint = parseOwn([own({ why: '  new route,\n\tcalled   without\r\nan order ' })], ROOT);
    expect(hint.ok && hint.findings[0]?.why).toBe('new route, called without an order');
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

  it('path-not-a-file-and-empty-warnings', () => {
    const own1 = parseOwn([own({ file: '.', source: 'eslint' }), own({ file: 'src/auth/' }), own({ file: 'file://' }), own()], ROOT);
    expect(own1.ok && own1.warnings.map((w) => w.message)).toEqual([
      'skipped: path "." is not a file',
      'skipped: path "src/auth/" is not a file',
      'skipped: empty path',
    ]);
    // Entries skipped for their path still count for the sources the import covers.
    expect(own1.ok && own1.findings).toHaveLength(1);
    expect(own1.ok && own1.sources).toEqual(['eslint', 'claude']);
    const uri = (value: string): Record<string, unknown> => sarifResult({ locations: [{ physicalLocation: { artifactLocation: { uri: value } } }] });
    const fromSarif = parseSarif(sarif([uri('file://'), uri('./')]), ROOT);
    expect(fromSarif.ok && fromSarif.warnings.map((w) => w.message)).toEqual(['skipped: empty path', 'skipped: path "./" is not a file']);
  });

  it('sarif-no-ruleid-title-from-first-line', () => {
    const titleOf = (text: string): FindingInput | undefined =>
      okFindings(parseSarif(sarif([sarifResult({ ruleId: undefined, message: { text } })]), ROOT))[0];
    // First line only, whitespace collapsed; the message keeps the full text.
    const multi = 'Order   is\tused\n\nbefore it is checked.';
    expect(titleOf(multi)?.title).toBe('Order is used');
    expect(titleOf(multi)?.message).toBe(multi);
    // Leading blank lines are skipped.
    expect(titleOf('\n  \r\n  Guard allows all.\nMore.')?.title).toBe('Guard allows all.');
    // Exactly 200 characters: kept as is. Longer: cut to 200 with a trailing ellipsis.
    expect(titleOf('a'.repeat(200))?.title).toBe('a'.repeat(200));
    expect(titleOf('a'.repeat(201))?.title).toBe(`${'a'.repeat(200)}…`);
    // Characters, not UTF-16 units or code points: an emoji or a combined character is never split.
    expect(titleOf('😀'.repeat(250))?.title).toBe(`${'😀'.repeat(200)}…`);
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(titleOf(family.repeat(201))?.title).toBe(`${family.repeat(200)}…`);
    expect(titleOf('e\u0301'.repeat(201))?.title).toBe(`${'e\u0301'.repeat(200)}…`);
    // 200 characters or 4 KiB, whichever comes first: 201 tag-sequence flags (28 bytes each) are cut by bytes.
    const flag = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    expect(Buffer.byteLength(flag, 'utf8')).toBe(28);
    const flags = parseSarif(sarif([sarifResult({ ruleId: undefined, message: { text: flag.repeat(201) } })]), ROOT);
    expect(flags.ok).toBe(true);
    const flagTitle = flags.ok ? (flags.findings[0]?.title ?? '') : '';
    expect(Buffer.byteLength(flagTitle, 'utf8')).toBeLessThanOrEqual(4096);
    expect(flagTitle.endsWith('…')).toBe(true);
    // Whole flags only: (4096 - 3 bytes of the ellipsis) / 28 = 146.
    expect(flagTitle).toBe(`${flag.repeat(146)}…`);
    // Under both limits: kept whole, even when close to 4 KiB.
    expect(titleOf(flag.repeat(146))?.title).toBe(flag.repeat(146));
    // A message over the 4 KiB title limit no longer rejects the file; the 16 KiB message limit still does.
    const long = `${'x'.repeat(5_000)}\nsecond line`;
    expect(titleOf(long)?.title).toBe(`${'x'.repeat(200)}…`);
    expect(titleOf(long)?.message).toBe(long);
    expect(parseSarif(sarif([sarifResult({ ruleId: undefined, message: { text: 'x'.repeat(16 * 1024 + 1) } })]), ROOT).ok).toBe(false);
    // A ruleId is still the title as given, and still limited to 4 KiB.
    expect(parseSarif(sarif([sarifResult({ ruleId: 'r'.repeat(4097) })]), ROOT).ok).toBe(false);
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

  it('import-rule-source-skipped', () => {
    // Rule findings come only from the snapshot worker (ADR-030): an import cannot claim a rule source.
    const ownResult = parseOwn([own({ source: 'rule:size' }), own(), own({ source: '  rule:layers' })], ROOT);
    expect(ownResult).toEqual({
      ok: true,
      findings: [expect.objectContaining({ source: 'claude' })],
      warnings: [
        { at: 'findings[0]', message: 'skipped: source "rule:size" is reserved for rule findings' },
        { at: 'findings[2]', message: 'skipped: source "rule:layers" is reserved for rule findings' },
      ],
      sources: ['claude'],
    });
    const log = {
      runs: [
        { tool: { driver: { name: 'rule:size' } }, results: [sarifResult(), sarifResult()] },
        { tool: { driver: { name: 'semgrep' } }, results: [sarifResult()] },
      ],
    };
    expect(parseSarif(log, ROOT)).toEqual({
      ok: true,
      findings: [expect.objectContaining({ source: 'semgrep' })],
      warnings: [{ at: 'runs[0]', message: 'skipped: source "rule:size" is reserved for rule findings' }],
      sources: ['semgrep'],
    });
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
