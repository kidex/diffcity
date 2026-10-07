// Adversarial inputs for the findings core (ADR-036): odd SARIF shapes, unicode
// and normalization collisions, Windows paths, out-of-range lines, overlay
// edges and dedup determinism. Fixture: the invented shopfront Report.

import { describe, expect, it } from 'vitest';
import {
  anchor,
  dedup,
  findingKey,
  normalizeTitle,
  overlay,
  parseOwn,
  parseSarif,
  reanchor,
} from '../../../src/core/findings/index.js';
import type { FindingInput, ParseResult, StoredFinding } from '../../../src/core/findings/index.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { deepFreeze, shopfrontFingerprints, shopfrontReport } from './support.js';

const ROOT = '/work/shopfront';
const ORDERS = 'src/orders/orders.service.ts';
const GUARD = 'src/auth/order.guard.ts';
const CONTROLLER = 'src/orders/orders.controller.ts';
const FORMAT = 'src/util/format.ts';

function ok(result: ParseResult): Extract<ParseResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.errors.join('; ')}`);
  return result;
}

function own(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'claude',
    severity: 'high',
    category: 'correctness',
    file: ORDERS,
    line: 15,
    title: 'Missing NotFound handling',
    message: 'svc.cancel throws NotFound.',
    ...overrides,
  };
}

function location(physical: Record<string, unknown>): Record<string, unknown> {
  return { physicalLocation: physical };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: 'shopfront.rule',
    level: 'warning',
    message: { text: 'Something is wrong.' },
    locations: [location({ artifactLocation: { uri: GUARD }, region: { startLine: 14 } })],
    ...overrides,
  };
}

function sarif(...runs: unknown[]): unknown {
  return { version: '2.1.0', runs };
}

function run(name: string | undefined, results: unknown): Record<string, unknown> {
  return { tool: { driver: name === undefined ? {} : { name } }, results };
}

function input(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    source: 'claude',
    severity: 'med',
    category: 'correctness',
    file: ORDERS,
    line: 15,
    title: 'Missing NotFound handling',
    message: 'svc.cancel throws NotFound.',
    ...overrides,
  };
}

function stored(overrides: Partial<FindingInput> = {}, report: Report = shopfrontReport()): StoredFinding {
  const anchored = anchor(input(overrides), report, shopfrontFingerprints());
  if (!anchored.ok) throw new Error('not anchored');
  return anchored.stored;
}

describe('findings adversarial: SARIF shapes', () => {
  it('sarif-runs-missing-or-not-array-rejected', () => {
    for (const log of [{}, { version: '2.1.0' }, { runs: {} }, { runs: 'x' }, [], null, 'runs']) {
      const parsed = parseSarif(log, ROOT);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.errors).toEqual(['not a SARIF 2.1 log: "runs" must be an array']);
    }
  });

  it('sarif-empty-runs-covers-nothing', () => {
    const parsed = ok(parseSarif(sarif(), ROOT));
    expect(parsed).toEqual({ ok: true, findings: [], warnings: [], sources: [] });
  });

  it('sarif-non-array-results-covers-nothing', () => {
    const parsed = ok(
      parseSarif(sarif(run('semgrep', { 0: result() }), run('eslint', 'none'), run('gitleaks', null), 42, null, run('tsc', [])), ROOT),
    );
    expect(parsed.findings).toEqual([]);
    // Only the run with a real (empty) results array covers its source.
    expect(parsed.sources).toEqual(['tsc']);
  });

  it('sarif-non-object-result-skipped-with-warning', () => {
    const parsed = ok(parseSarif(sarif(run('semgrep', [null, 'x', 7, [], result()])), ROOT));
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.warnings.map((w) => w.at)).toEqual([
      'runs[0].results[0]',
      'runs[0].results[1]',
      'runs[0].results[2]',
      'runs[0].results[3]',
    ]);
    expect(parsed.warnings.every((w) => w.message === 'skipped: not an object')).toBe(true);
  });

  it('sarif-logical-location-only-skipped', () => {
    const parsed = ok(
      parseSarif(
        sarif(
          run('semgrep', [
            result({ locations: [{ logicalLocations: [{ fullyQualifiedName: 'OrdersService.cancel' }] }] }),
            result({ locations: 'src/a.ts' }),
            result({ locations: [location({ artifactLocation: { uri: '   ' } })] }),
            result({ locations: [location({ artifactLocation: { index: 0 } })] }),
            result({ locations: [null] }),
          ]),
        ),
        ROOT,
      ),
    );
    expect(parsed.findings).toEqual([]);
    expect(parsed.warnings).toHaveLength(5);
    expect(parsed.warnings.every((w) => w.message === 'skipped: no physical location')).toBe(true);
    expect(parsed.sources).toEqual(['semgrep']);
  });

  it('sarif-only-first-location-used', () => {
    const parsed = ok(
      parseSarif(
        sarif(
          run('semgrep', [
            result({
              locations: [
                { logicalLocations: [{ name: 'x' }] },
                location({ artifactLocation: { uri: GUARD }, region: { startLine: 3 } }),
              ],
            }),
          ]),
        ),
        ROOT,
      ),
    );
    // locations[0] has no physical location: the second one is not used in its place.
    expect(parsed.findings).toEqual([]);
    expect(parsed.warnings[0]?.message).toBe('skipped: no physical location');
  });

  it('sarif-start-line-zero-negative-fraction-or-text-uses-line-1', () => {
    const lines: unknown[] = [0, -5, 2.5, '14', null, Number.NaN];
    const parsed = ok(
      parseSarif(
        sarif(run('semgrep', lines.map((startLine) => result({ locations: [location({ artifactLocation: { uri: GUARD }, region: { startLine } })] })))),
        ROOT,
      ),
    );
    expect(parsed.findings.map((f) => f.line)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(parsed.warnings.map((w) => w.message)).toEqual(Array(6).fill('no region.startLine, line 1 used'));
  });

  it('sarif-huge-line-and-column-kept-and-file-level', () => {
    const parsed = ok(
      parseSarif(
        sarif(
          run('semgrep', [
            result({
              locations: [
                location({
                  artifactLocation: { uri: GUARD },
                  region: { startLine: 2_000_000_000, startColumn: Number.MAX_SAFE_INTEGER, endColumn: 1e300 },
                }),
              ],
            }),
          ]),
        ),
        ROOT,
      ),
    );
    expect(parsed.warnings).toEqual([]);
    expect(parsed.findings[0]?.line).toBe(2_000_000_000);
    const anchored = anchor(parsed.findings[0] as FindingInput, shopfrontReport());
    expect(anchored.ok).toBe(true);
    if (anchored.ok) expect(anchored.stored.finding.symbolId).toBeUndefined();
  });

  it('sarif-level-unknown-values-are-low', () => {
    const parsed = ok(parseSarif(sarif(run('semgrep', [result({ level: 'ERROR' }), result({ level: 3 }), result({ level: 'fatal' })])), ROOT));
    expect(parsed.findings.map((f) => f.severity)).toEqual(['low', 'low', 'low']);
  });

  it('sarif-driver-name-blank-or-missing-is-sarif', () => {
    const parsed = ok(parseSarif(sarif(run(undefined, [result()]), run('   ', [result()]), { results: [result()] }), ROOT));
    expect(parsed.findings.map((f) => f.source)).toEqual(['sarif', 'sarif', 'sarif']);
    expect(parsed.sources).toEqual(['sarif']);
  });

  it('sarif-limit-counts-results-across-runs', () => {
    const many = Array.from({ length: 2_501 }, () => result());
    const parsed = parseSarif(sarif(run('a', many), run('b', many)), ROOT);
    expect(parsed.ok).toBe(false);
    const exact = parseSarif(sarif(run('a', many), run('b', many.slice(2))), ROOT);
    expect(exact.ok).toBe(true);
  });
});

describe('findings adversarial: paths', () => {
  it('own-windows-backslash-path-normalized', () => {
    const parsed = ok(parseOwn([own({ file: 'src\\orders\\orders.service.ts' }), own({ file: '.\\src\\util\\format.ts' })], ROOT));
    expect(parsed.findings.map((f) => f.file)).toEqual([ORDERS, FORMAT]);
  });

  it('own-windows-traversal-skipped', () => {
    const parsed = ok(parseOwn([own({ file: 'src\\..\\..\\etc\\passwd' }), own()], ROOT));
    expect(parsed.findings.map((f) => f.file)).toEqual([ORDERS]);
    expect(parsed.warnings[0]?.message).toMatch(/contains "\.\."/);
  });

  it('own-windows-absolute-path-made-relative', () => {
    const parsed = ok(parseOwn([own({ file: 'C:\\work\\shopfront\\src\\orders\\orders.service.ts' })], 'C:\\work\\shopfront\\'));
    expect(parsed.findings.map((f) => f.file)).toEqual([ORDERS]);
    const outside = ok(parseOwn([own({ file: 'D:\\other\\src\\a.ts' })], 'C:\\work\\shopfront'));
    expect(outside.findings).toEqual([]);
    expect(outside.warnings[0]?.message).toMatch(/outside the repository/);
  });

  it('sarif-windows-file-uri-made-relative', () => {
    const parsed = ok(
      parseSarif(
        sarif(
          run('semgrep', [
            result({ locations: [location({ artifactLocation: { uri: 'file:///C:/work/shopfront/src/orders/orders.service.ts' } })] }),
            result({ locations: [location({ artifactLocation: { uri: 'file:///C:/work/shop%20front/src/a.ts' } })] }),
          ]),
        ),
        'C:\\work\\shopfront',
      ),
    );
    expect(parsed.findings.map((f) => f.file)).toEqual([ORDERS]);
    expect(parsed.warnings.map((w) => w.message)).toContain('skipped: absolute path "C:/work/shop front/src/a.ts" is outside the repository');
  });

  it('sarif-relative-backslash-and-encoded-uri', () => {
    const parsed = ok(
      parseSarif(
        sarif(
          run('semgrep', [
            result({ locations: [location({ artifactLocation: { uri: 'src\\orders\\orders.service.ts' } })] }),
            result({ locations: [location({ artifactLocation: { uri: 'src/util/my%20format.ts' } })] }),
            result({ locations: [location({ artifactLocation: { uri: 'src/%2e%2e/%2e%2e/secret.ts' } })] }),
            result({ locations: [location({ artifactLocation: { uri: 'src/100%.ts' } })] }),
          ]),
        ),
        ROOT,
      ),
    );
    expect(parsed.findings.map((f) => f.file)).toEqual([ORDERS, 'src/util/my format.ts', 'src/100%.ts']);
    expect(parsed.warnings.filter((w) => w.message.startsWith('skipped')).map((w) => w.message)).toEqual([
      'skipped: path "src/../../secret.ts" contains ".."',
    ]);
  });

  it('sarif-file-uri-equal-to-root-skipped', () => {
    const parsed = ok(parseSarif(sarif(run('semgrep', [result({ locations: [location({ artifactLocation: { uri: `file://${ROOT}` } })] })])), ROOT));
    expect(parsed.findings).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('own-root-prefix-sibling-not-inside', () => {
    // /work/shopfront-old is not inside /work/shopfront.
    const parsed = ok(parseOwn([own({ file: '/work/shopfront-old/src/a.ts' })], ROOT));
    expect(parsed.findings).toEqual([]);
    expect(parsed.warnings[0]?.message).toMatch(/outside the repository/);
  });
});

describe('findings adversarial: titles and keys', () => {
  it('own-unicode-title-kept-and-normalized', () => {
    const parsed = ok(parseOwn([own({ title: '  Ödeme işlemi — eksik kontrol…  ', message: 'Zahlung prüfen 🚫' })], ROOT));
    expect(parsed.findings[0]?.title).toBe('Ödeme işlemi — eksik kontrol…');
    expect(normalizeTitle('Ödeme   İŞLEMİ — eksik kontrol…')).toBe(normalizeTitle('ödeme i̇şlemi̇ — eksik kontrol'));
  });

  it('own-unicode-size-counted-in-bytes', () => {
    // 1,366 three-byte characters are 4,098 bytes: over the 4 KiB title limit though under 4,096 characters.
    const parsed = parseOwn([own({ title: '€'.repeat(1_366) })], ROOT);
    expect(parsed.ok).toBe(false);
    expect(parseOwn([own({ title: '€'.repeat(1_365) })], ROOT).ok).toBe(true);
  });

  it('normalization-collision-same-key-and-one-entry', () => {
    const a = stored({ title: 'Missing NotFound handling' });
    const b = stored({ title: '  missing\tNOTFOUND   handling!!! ' });
    expect(b.key).toBe(a.key);
    expect(findingKey('claude', ORDERS, 'correctness', 'Missing NotFound handling.', 15)).toBe(a.key);
    expect(dedup([a, b])).toHaveLength(1);
    // Inner punctuation is not removed: a different title, a different entry.
    expect(dedup([a, stored({ title: 'Missing Not-Found handling' })])).toHaveLength(2);
  });

  it('key-separators-do-not-collide', () => {
    // NUL separators: shifting text between source and file gives a different key.
    expect(findingKey('a', 'b/c.ts', 'correctness', 't', 1)).not.toBe(findingKey('a\0b', 'c.ts', 'correctness', 't', 1));
    expect(findingKey('claude', ORDERS, 'correctness', 'x', 1)).not.toBe(findingKey('claude', ORDERS, 'correctness', 'x', 11));
    expect(findingKey('claude', ORDERS, 'correctness', 'x', 1)).toMatch(/^f:[0-9a-f]{16}$/);
    expect(findingKey('claude', ORDERS, 'correctness', 'x', 1)).not.toBe(findingKey('claude', ORDERS, 'security', 'x', 1));
  });
});

describe('findings adversarial: anchoring edges', () => {
  it('anchor-line-beyond-every-symbol-file-level', () => {
    const far = stored({ line: 10_000 });
    expect(far.finding.symbolId).toBeUndefined();
    expect(far.anchor.symbolName).toBeUndefined();
    expect(far.anchor.fingerprint).toBe('s1');
    // Re-anchored on the same head, it stays file level on its line.
    const again = reanchor(far, shopfrontReport());
    expect(again?.line).toBe(10_000);
    expect(again?.symbolId).toBeUndefined();
  });

  it('anchor-nested-symbol-boundary-lines', () => {
    expect(stored({ line: 10 }).finding.symbolId).toBe(`${ORDERS}#OrdersService.cancel`);
    expect(stored({ line: 30 }).finding.symbolId).toBe(`${ORDERS}#OrdersService.cancel`);
    expect(stored({ line: 31 }).finding.symbolId).toBe(`${ORDERS}#OrdersService`);
    expect(stored({ line: 60 }).finding.symbolId).toBe(`${ORDERS}#OrdersService`);
    expect(stored({ line: 61 }).finding.symbolId).toBeUndefined();
  });
});

describe('findings adversarial: overlay', () => {
  it('overlay-finding-on-file-not-in-report-left-out', () => {
    const report = shopfrontReport();
    const other = shopfrontReport();
    other.packages[1]?.files.push({
      id: 'src/orders/orders.repo.ts',
      path: 'src/orders/orders.repo.ts',
      language: 'typescript',
      status: 'add',
      verdict: 'ok',
      inSpec: null,
      symbols: [],
    });
    const gone = stored({ file: 'src/orders/orders.repo.ts', line: 3, severity: 'high' }, other);
    const kept = stored({ line: 15 });
    const served = overlay(deepFreeze(report), [gone, kept], {});
    expect(served.findings.map((f) => f.id)).toEqual([kept.key]);
    expect(served.packages.flatMap((p) => p.files).map((f) => f.path)).not.toContain('src/orders/orders.repo.ts');
  });

  it('overlay-summary-counts-every-verdict', () => {
    const report = shopfrontReport();
    const served = overlay(deepFreeze(report), [stored({ line: 15, severity: 'high' }), stored({ file: CONTROLLER, line: 6, severity: 'med' })], {});
    // guard: tier 1 → eyes; orders: open high → risky; controller: med only → ok; format: same.
    expect(served.summary.byVerdict).toEqual({ eyes: 1, risky: 1, spec: 0, ok: 1, same: 1 });
    expect(Object.values(served.summary.byVerdict).reduce((a, b) => a + b, 0)).toBe(served.summary.files);
    expect(served.summary.byStatus).toEqual(report.summary.byStatus);
    expect(served.summary.tier1Files).toEqual(report.summary.tier1Files);
    // Every finding fixed: back to the stored counts.
    const fixed = overlay(report, [stored({ line: 15, severity: 'high', state: 'fixed' })], {});
    expect(fixed.summary.byVerdict).toEqual({ eyes: 1, risky: 0, spec: 0, ok: 2, same: 1 });
  });

  it('overlay-rule-state-applied-and-imported-merged', () => {
    const report = shopfrontReport();
    const rule: Finding = {
      id: 'rule:size:abc',
      source: 'rule:size',
      severity: 'high',
      category: 'scope',
      file: CONTROLLER,
      line: 6,
      title: 'File too large',
      message: 'Over the limit.',
      state: 'open',
    };
    const changeLevel: Finding = { ...rule, id: 'rule:scope:def', source: 'rule:scope', file: '', line: 0, title: 'Change too wide' };
    report.findings = [rule, changeLevel];
    const served = overlay(deepFreeze(report), [], { 'rule:size:abc': 'intended' });
    expect(served.findings.find((f) => f.id === rule.id)).toMatchObject({ state: 'intended', symbolId: `${CONTROLLER}#cancelRoute` });
    expect(served.findings.find((f) => f.id === changeLevel.id)).toEqual(changeLevel);
    expect(served.packages.flatMap((p) => p.files).find((f) => f.path === CONTROLLER)?.verdict).toBe('ok');
    const open = overlay(report, [], {});
    expect(open.packages.flatMap((p) => p.files).find((f) => f.path === CONTROLLER)?.verdict).toBe('risky');
  });

  it('overlay-unique-finding-ids', () => {
    // Same source, file, line and title but another category: a separate dedup entry.
    // Both are served; their ids must still tell them apart.
    const a = stored({ category: 'correctness' });
    const b = stored({ category: 'security' });
    const served = overlay(shopfrontReport(), [a, b], {});
    expect(served.findings).toHaveLength(2);
    const ids = served.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('findings adversarial: dedup determinism', () => {
  function parts(): StoredFinding[] {
    return [
      stored({ source: 'semgrep', severity: 'low', line: 12, fix: '' }),
      stored({ source: 'claude', severity: 'high', line: 15, title: 'missing notfound handling.', fix: 'Map NotFound to 404.' }),
      stored({ source: 'eslint', severity: 'med', line: 20, state: 'fixed', fix: 'Catch it.' }),
      stored({ source: 'claude', severity: 'med', line: 40, title: 'Refund twice' }),
      stored({ source: 'semgrep', severity: 'high', line: 45, title: 'refund TWICE', state: 'intended' }),
      stored({ source: 'semgrep', severity: 'low', line: 65, title: 'File level note' }),
    ];
  }

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
  }

  it('dedup-same-order-same-output', () => {
    const first = dedup(parts());
    for (let i = 0; i < 5; i += 1) expect(dedup(parts())).toEqual(first);
    const served = overlay(shopfrontReport(), parts(), {});
    expect(overlay(shopfrontReport(), parts(), {})).toEqual(served);
  });

  it('dedup-permutations-same-groups-severity-state', () => {
    const summary = (entries: StoredFinding[]): string[] =>
      entries
        .map((e) => `${e.finding.symbolId ?? e.finding.file}|${normalizeTitle(e.finding.title)}|${e.finding.severity}|${e.finding.state}|${[...(e.finding.sources ?? [])].sort().join(',')}`)
        .sort();
    const expected = summary(dedup(parts()));
    expect(expected).toEqual([
      `${ORDERS}#OrdersService.cancel|missing notfound handling|high|open|claude,eslint,semgrep`,
      `${ORDERS}#OrdersService.refund|refund twice|high|intended|claude,semgrep`,
      `${ORDERS}|file level note|low|open|semgrep`,
    ]);
    for (const order of permutations(parts())) expect(summary(dedup(order))).toEqual(expected);
  });

  it('dedup-first-in-order-is-primary-and-first-non-empty-fix-wins', () => {
    const [semgrep, claude, eslint] = parts();
    if (semgrep === undefined || claude === undefined || eslint === undefined) throw new Error('fixture');
    const merged = dedup([semgrep, claude, eslint])[0];
    expect(merged?.key).toBe(semgrep.key);
    expect(merged?.finding.source).toBe('semgrep');
    expect(merged?.finding.sources).toEqual(['semgrep', 'claude', 'eslint']);
    expect(merged?.finding.fix).toBe('Map NotFound to 404.');
    const reversed = dedup([eslint, claude, semgrep])[0];
    expect(reversed?.finding.source).toBe('eslint');
    expect(reversed?.finding.sources).toEqual(['eslint', 'claude', 'semgrep']);
    expect(reversed?.finding.fix).toBe('Catch it.');
    expect(reversed?.finding.state).toBe('open');
  });
});
