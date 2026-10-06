import { describe, expect, it } from 'vitest';
import { anchor, dedup, findingKey } from '../../../src/core/findings/index.js';
import type { FindingInput, StoredFinding } from '../../../src/core/findings/index.js';
import { shopfrontFingerprints, shopfrontReport } from './support.js';

const ORDERS = 'src/orders/orders.service.ts';

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

function stored(overrides: Partial<FindingInput> = {}): StoredFinding {
  const result = anchor(input(overrides), shopfrontReport(), shopfrontFingerprints());
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

describe('findings', () => {
  it('anchor-line-in-symbol', () => {
    const result = anchor(input(), shopfrontReport(), shopfrontFingerprints());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Line 15 is in both the class and the method: the innermost wins.
    expect(result.stored.finding.symbolId).toBe(`${ORDERS}#OrdersService.cancel`);
    expect(result.stored.finding.state).toBe('open');
    expect(result.stored.finding.sources).toEqual(['claude']);
    expect(result.stored.anchor).toEqual({
      symbolName: 'OrdersService.cancel',
      symbolKind: 'method',
      symbolStart: 10,
      fingerprint: 'sym-cancel',
    });
  });

  it('anchor-line-between-symbols-file-level', () => {
    const result = anchor(input({ line: 65 }), shopfrontReport(), shopfrontFingerprints());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stored.finding.symbolId).toBeUndefined();
    expect('symbolId' in result.stored.finding).toBe(false);
    expect(result.stored.anchor).toEqual({ fingerprint: 's1' });
  });

  it('anchor-file-not-in-change-skipped', () => {
    expect(anchor(input({ file: 'src/other/unknown.ts' }), shopfrontReport())).toEqual({
      ok: false,
      reason: 'skipped-not-in-change',
    });
  });

  it('anchor-line-in-del-symbol-not-matched', () => {
    // legacyCancel is a deleted symbol at lines 70-80: the line stays at file level.
    const result = anchor(input({ line: 75 }), shopfrontReport());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stored.finding.symbolId).toBeUndefined();
  });

  it('dedup-same-symbol-category-title', () => {
    const merged = dedup([stored({ line: 12 }), stored({ source: 'semgrep', line: 20 })]);
    expect(merged).toHaveLength(1);
  });

  it('dedup-sources-listed-first-source-primary', () => {
    const merged = dedup([stored({ source: 'semgrep' }), stored({ source: 'claude' }), stored({ source: 'semgrep', line: 22 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.finding.source).toBe('semgrep');
    expect(merged[0]?.finding.sources).toEqual(['semgrep', 'claude']);
    expect(merged[0]?.key).toBe(stored({ source: 'semgrep' }).key);
  });

  it('dedup-highest-severity', () => {
    const merged = dedup([
      stored({ severity: 'low', fix: '' }),
      stored({ source: 'a', severity: 'high', fix: 'Map it to a 404.' }),
      stored({ source: 'b', severity: 'med', fix: 'Other fix.' }),
    ]);
    expect(merged[0]?.finding.severity).toBe('high');
    expect(merged[0]?.finding.fix).toBe('Map it to a 404.');
    expect(dedup([stored({ state: 'open' }), stored({ source: 'a', state: 'intended' })])[0]?.finding.state).toBe('intended');
  });

  it('dedup-different-category-kept', () => {
    expect(dedup([stored(), stored({ category: 'security' })])).toHaveLength(2);
    expect(dedup([stored(), stored({ line: 35 })])).toHaveLength(2);
    expect(dedup([stored({ line: 65 }), stored({ line: 66 })])).toHaveLength(1);
    expect(dedup([stored({ line: 65 }), stored({ file: 'src/util/format.ts', line: 66 })])).toHaveLength(2);
  });

  it('dedup-normalized-title', () => {
    const merged = dedup([
      stored({ title: 'Missing NotFound handling' }),
      stored({ source: 'a', title: '  missing   NOTFOUND\thandling. ' }),
      stored({ source: 'b', title: 'Missing NotFound handling!?' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.finding.sources).toEqual(['claude', 'a', 'b']);
  });

  it('key-stable-across-imports', () => {
    const first = stored({ id: 'cr-1' });
    const second = stored({ id: 'cr-2' });
    expect(first.key).toMatch(/^f:[0-9a-f]{16}$/);
    expect(second.key).toBe(first.key);
    expect(first.alias).toBe('cr-1');
    expect(first.finding.id).toBe(first.key);
    expect(findingKey('claude', ORDERS, '  Missing NotFound Handling.', 15)).toBe(first.key);
    expect(findingKey('semgrep', ORDERS, 'Missing NotFound handling', 15)).not.toBe(first.key);
    expect(findingKey('claude', ORDERS, 'Missing NotFound handling', 16)).not.toBe(first.key);
  });
});
