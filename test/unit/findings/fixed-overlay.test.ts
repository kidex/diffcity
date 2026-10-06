import { describe, expect, it } from 'vitest';
import { anchor, fixedKeys, overlay, reanchor } from '../../../src/core/findings/index.js';
import type { FindingInput, StoredFinding } from '../../../src/core/findings/index.js';
import type { Fingerprints } from '../../../src/core/model/types.js';
import type { File, Report } from '../../../src/core/report/types.js';
import { fileVerdict } from '../../../src/core/verdict/index.js';
import { deepFreeze, shopfrontFingerprints, shopfrontReport, symbol } from './support.js';

const ORDERS = 'src/orders/orders.service.ts';
const CONTROLLER = 'src/orders/orders.controller.ts';
const GUARD = 'src/auth/order.guard.ts';

function input(overrides: Partial<FindingInput> = {}): FindingInput {
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

function stored(overrides: Partial<FindingInput> = {}, report: Report = shopfrontReport(), fp: Fingerprints = shopfrontFingerprints()): StoredFinding {
  const result = anchor(input(overrides), report, fp);
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

function files(report: Report): File[] {
  return report.packages.flatMap((pkg) => pkg.files);
}

function verdictOf(report: Report, path: string): string | undefined {
  return files(report).find((f) => f.path === path)?.verdict;
}

describe('findings', () => {
  it('fixed-when-symbol-changed-and-not-reported', () => {
    const open = stored();
    const fp = shopfrontFingerprints();
    fp.symbols[`${ORDERS}#OrdersService.cancel`] = 'sym-cancel-edited';
    const other = stored({ line: 40, title: 'Another thing' });
    expect(fixedKeys({ stored: [open], imported: [other], report: shopfrontReport(), fingerprints: fp })).toEqual([open.key]);
    // A symbol that no longer exists counts as changed.
    const report = shopfrontReport();
    const orders = files(report).find((f) => f.path === ORDERS);
    if (orders === undefined) throw new Error('fixture');
    orders.symbols = orders.symbols.filter((s) => s.name !== 'OrdersService.cancel');
    expect(fixedKeys({ stored: [open], imported: [other], report, fingerprints: shopfrontFingerprints() })).toEqual([open.key]);
  });

  it('stays-open-when-symbol-unchanged', () => {
    const open = stored();
    const other = stored({ line: 40, title: 'Another thing' });
    const args = { report: shopfrontReport(), fingerprints: shopfrontFingerprints() };
    expect(fixedKeys({ stored: [open], imported: [other], ...args })).toEqual([]);
    // Changed anchor but reported again (same key, or same symbol, category and title): stays open.
    const changed = shopfrontFingerprints();
    changed.symbols[`${ORDERS}#OrdersService.cancel`] = 'edited';
    expect(fixedKeys({ stored: [open], imported: [stored()], report: shopfrontReport(), fingerprints: changed })).toEqual([]);
    expect(fixedKeys({ stored: [open], imported: [stored({ line: 18 })], report: shopfrontReport(), fingerprints: changed })).toEqual([]);
    // Another source, a closed finding and an unknown fingerprint are never fixed.
    const otherSource = stored({ source: 'semgrep' });
    expect(fixedKeys({ stored: [otherSource], imported: [other], report: shopfrontReport(), fingerprints: changed })).toEqual([]);
    expect(fixedKeys({ stored: [stored({ state: 'intended' })], imported: [other], report: shopfrontReport(), fingerprints: changed })).toEqual([]);
    const unknown = anchor(input(), shopfrontReport());
    if (!unknown.ok) throw new Error('anchor');
    expect(fixedKeys({ stored: [unknown.stored], imported: [other], report: shopfrontReport(), fingerprints: changed })).toEqual([]);
    // A file-level finding compares the file fingerprint.
    const fileLevel = stored({ line: 65 });
    const fileEdited = shopfrontFingerprints();
    expect(fixedKeys({ stored: [fileLevel], imported: [other], report: shopfrontReport(), fingerprints: fileEdited })).toEqual([]);
    fileEdited.files[ORDERS] = { before: 's0', after: 's2' };
    expect(fixedKeys({ stored: [fileLevel], imported: [other], report: shopfrontReport(), fingerprints: fileEdited })).toEqual([fileLevel.key]);
    // Sources the import covers can be named when it reported nothing.
    expect(fixedKeys({ stored: [open], imported: [], report: shopfrontReport(), fingerprints: changed, sources: ['claude'] })).toEqual([open.key]);
    expect(fixedKeys({ stored: [open], imported: [], report: shopfrontReport(), fingerprints: changed })).toEqual([]);
  });

  it('fixed-when-file-left-change', () => {
    const open = stored({ file: GUARD, line: 14, title: 'Guard defaults to allow' });
    const report = shopfrontReport();
    report.packages = report.packages.filter((p) => p.path !== 'src/auth');
    const other = stored({ line: 40, title: 'Another thing' });
    expect(fixedKeys({ stored: [open], imported: [other], report, fingerprints: shopfrontFingerprints() })).toEqual([open.key]);
  });

  it('reanchor-by-symbol-after-line-shift', () => {
    const open = stored({ line: 15 });
    const report = shopfrontReport();
    const orders = files(report).find((f) => f.path === ORDERS);
    if (orders === undefined) throw new Error('fixture');
    orders.symbols = [
      symbol(ORDERS, 'OrdersService', 'class', 'mod', 1, 70),
      symbol(ORDERS, 'OrdersService.refund', 'method', 'mod', 10, 28),
      symbol(ORDERS, 'OrdersService.cancel', 'method', 'mod', 30, 52),
    ];
    const finding = reanchor(open, report);
    expect(finding).toMatchObject({ symbolId: `${ORDERS}#OrdersService.cancel`, line: 35 });
    // The stored finding is not changed.
    expect(open.finding.line).toBe(15);
  });

  it('reanchor-line-fallback', () => {
    const open = stored({ line: 15 });
    const report = shopfrontReport();
    const orders = files(report).find((f) => f.path === ORDERS);
    if (orders === undefined) throw new Error('fixture');
    // cancel is gone: line 15 falls in the class.
    orders.symbols = [symbol(ORDERS, 'OrdersService', 'class', 'mod', 1, 60)];
    expect(reanchor(open, report)).toMatchObject({ symbolId: `${ORDERS}#OrdersService`, line: 15 });
    // The file got shorter than the line: clamped to the last symbol.
    orders.symbols = [symbol(ORDERS, 'OrdersService', 'class', 'mod', 1, 9)];
    expect(reanchor(open, report)).toMatchObject({ symbolId: `${ORDERS}#OrdersService`, line: 9 });
    // No symbol at the line: file level.
    orders.symbols = [symbol(ORDERS, 'OrdersService.refund', 'method', 'mod', 40, 50), symbol(ORDERS, 'other', 'function', 'mod', 1, 5)];
    const fileLevel = reanchor(open, report);
    expect(fileLevel?.symbolId).toBeUndefined();
    // A file that left the change: dropped from the overlay, back when the file returns.
    const gone = shopfrontReport();
    gone.packages = gone.packages.filter((p) => p.path !== 'src/orders');
    expect(reanchor(open, gone)).toBeNull();
    expect(overlay(gone, [open], {}).findings).toEqual([]);
    expect(overlay(shopfrontReport(), [open], {}).findings).toHaveLength(1);
  });

  it('overlay-verdict-risky-on-open-high', () => {
    const report = shopfrontReport();
    const served = overlay(report, [stored(), stored({ file: CONTROLLER, line: 8, title: 'Low one', severity: 'low' })], {});
    expect(verdictOf(served, ORDERS)).toBe('risky');
    expect(verdictOf(served, CONTROLLER)).toBe('ok');
    expect(served.findings).toHaveLength(2);
    expect(served.findings[0]?.sources).toEqual(['claude']);
    // The same verdict as fileVerdict gives with that findings input.
    const orders = files(served).find((f) => f.path === ORDERS);
    expect(orders?.verdict).toBe(
      fileVerdict({ status: 'mod', symbolStatuses: orders?.symbols.map((s) => s.status) ?? [], tier1: false, findings: served.findings, inSpec: null }),
    );
    // A rule finding of the Report counts, with its state from ruleStates.
    const withRule = shopfrontReport();
    withRule.findings = [
      { id: 'rule:size:abc', source: 'rule:size', severity: 'high', category: 'architecture', file: CONTROLLER, line: 8, title: 'Too big', message: 'm', state: 'open' },
      { id: 'rule:ci:def', source: 'rule:ci', severity: 'high', category: 'tests', file: '', line: 1, title: 'CI failed', message: 'm', state: 'open' },
    ];
    const ruled = overlay(withRule, [], {});
    expect(verdictOf(ruled, CONTROLLER)).toBe('risky');
    expect(ruled.findings[0]?.symbolId).toBe(`${CONTROLLER}#cancelRoute`);
    expect(verdictOf(ruled, ORDERS)).toBe('ok');
    expect(verdictOf(overlay(withRule, [], { 'rule:size:abc': 'intended' }), CONTROLLER)).toBe('ok');
  });

  it('overlay-intended-not-risky', () => {
    const served = overlay(shopfrontReport(), [stored({ state: 'intended' }), stored({ line: 40, title: 'Closed', state: 'fixed' })], {});
    expect(verdictOf(served, ORDERS)).toBe('ok');
    expect(served.findings.map((f) => f.state)).toEqual(['intended', 'fixed']);
    // Merged with an open duplicate from another source, "intended" wins.
    const merged = overlay(shopfrontReport(), [stored(), stored({ source: 'semgrep', state: 'intended' })], {});
    expect(merged.findings).toHaveLength(1);
    expect(verdictOf(merged, ORDERS)).toBe('ok');
  });

  it('overlay-tier1-stays-eyes', () => {
    const served = overlay(shopfrontReport(), [stored({ file: GUARD, line: 14, title: 'Guard defaults to allow' })], {});
    expect(verdictOf(served, GUARD)).toBe('eyes');
    expect(served.summary.byVerdict.eyes).toBe(1);
    const sig = shopfrontReport();
    const orders = files(sig).find((f) => f.path === ORDERS);
    if (orders === undefined) throw new Error('fixture');
    orders.symbols = [{ ...symbol(ORDERS, 'OrdersService.cancel', 'method', 'sig', 10, 30) }];
    expect(verdictOf(overlay(sig, [stored()], {}), ORDERS)).toBe('eyes');
  });

  it('overlay-untouched-stays-same', () => {
    const served = overlay(shopfrontReport(), [stored({ file: 'src/util/format.ts', line: 3, title: 'On an untouched file' })], {});
    expect(verdictOf(served, 'src/util/format.ts')).toBe('same');
  });

  it('overlay-summary-recounted', () => {
    const report = shopfrontReport();
    expect(report.summary.byVerdict).toEqual({ eyes: 1, risky: 0, spec: 0, ok: 2, same: 1 });
    const served = overlay(report, [stored(), stored({ file: CONTROLLER, line: 8, title: 'Other' })], {});
    expect(served.summary.byVerdict).toEqual({ eyes: 1, risky: 2, spec: 0, ok: 0, same: 1 });
    expect(served.summary.byStatus).toEqual(report.summary.byStatus);
    expect(served.summary.tier1Files).toEqual(report.summary.tier1Files);
    expect(served.checks).toEqual(report.checks);
    expect(served.meta).toEqual(report.meta);
    expect(served.steps).toEqual(report.steps);
  });

  it('overlay-does-not-touch-stored-report', () => {
    const report = deepFreeze(shopfrontReport());
    const findings = deepFreeze([stored(), stored({ source: 'semgrep', severity: 'low' }), stored({ line: 65, title: 'File level' })]);
    const states = deepFreeze({ 'rule:size:abc': 'intended' as const });
    const before = JSON.stringify(report);
    const served = overlay(report, findings, states);
    expect(JSON.stringify(report)).toBe(before);
    expect(served).not.toBe(report);
    expect(served.findings).toHaveLength(2);
    expect(report.findings).toEqual([]);
    expect(verdictOf(report, ORDERS)).toBe('ok');
    expect(verdictOf(served, ORDERS)).toBe('risky');
  });
});
