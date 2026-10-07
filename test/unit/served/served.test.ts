// The served Report and the finding a findings action names (ADR-036).

import { describe, expect, it } from 'vitest';
import { anchor, type FindingInput, type StoredFinding } from '../../../src/core/findings/index.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { hasOverlay, reportCounts, resolveFinding, servedCounts, servedRepoSummary, servedStats, serveOverlay, serveReport, stateTargets } from '../../../src/core/served/index.js';
import { shopfrontFingerprints, shopfrontReport } from '../findings/support.js';

const ORDERS = 'src/orders/orders.service.ts';
const CONTROLLER = 'src/orders/orders.controller.ts';

function stored(overrides: Partial<FindingInput> = {}): StoredFinding {
  const result = anchor(
    {
      source: 'claude',
      severity: 'high',
      category: 'correctness',
      file: CONTROLLER,
      line: 8,
      title: 'Cancel without an order',
      message: 'The route calls cancel without an order.',
      ...overrides,
    },
    shopfrontReport(),
    shopfrontFingerprints(),
  );
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

const RULE: Finding = {
  id: 'rule:size:0001',
  source: 'rule:size',
  severity: 'high',
  category: 'architecture',
  file: ORDERS,
  line: 12,
  title: 'File over 50 lines',
  message: 'orders.service.ts has 80 lines.',
  state: 'open',
};

function withRule(): Report {
  return { ...shopfrontReport(), findings: [RULE] };
}

function verdictOf(report: Report, path: string): string | undefined {
  return report.packages.flatMap((pkg) => pkg.files).find((file) => file.path === path)?.verdict;
}

describe('serveReport', () => {
  it('sends the stored string itself when there is nothing to overlay', () => {
    const odd = `{ "meta" : {"repo": "shopfront"},\n "packages": [] , "x": 1.50 }`;
    expect(serveReport(odd, { stored: [], ruleStates: {} })).toBe(odd);
  });

  it('overlays imported findings: the finding, the file verdict and byVerdict', () => {
    const json = JSON.stringify(shopfrontReport());
    const served = JSON.parse(serveReport(json, { stored: [stored()], ruleStates: {} })) as Report;
    expect(served.findings.map((f) => [f.title, f.state, f.symbolId])).toEqual([['Cancel without an order', 'open', `${CONTROLLER}#cancelRoute`]]);
    expect(verdictOf(served, CONTROLLER)).toBe('risky');
    expect(served.summary.byVerdict).toEqual({ eyes: 1, risky: 1, spec: 0, ok: 1, same: 1 });
    expect(served.checks).toEqual(shopfrontReport().checks);
  });

  it('applies a rule state alone', () => {
    const json = JSON.stringify(withRule());
    const open = JSON.parse(serveReport(json, { stored: [], ruleStates: { [RULE.id]: 'open' } })) as Report;
    expect(verdictOf(open, ORDERS)).toBe('risky');
    const intended = JSON.parse(serveReport(json, { stored: [], ruleStates: { [RULE.id]: 'intended' } })) as Report;
    expect(intended.findings[0]?.state).toBe('intended');
    expect(verdictOf(intended, ORDERS)).toBe('ok');
  });
});

describe('served counts (DC-106)', () => {
  it('serveOverlay gives the served text and the counts it carries; servedCounts the same counts', () => {
    const json = JSON.stringify(withRule());
    const findings = { stored: [stored()], ruleStates: { [RULE.id]: 'intended' as const } };
    const served = serveOverlay(json, findings);
    expect(served.body).toBe(serveReport(json, findings));
    expect(served.counts?.byVerdict).toEqual((JSON.parse(served.body) as Report).summary.byVerdict);
    expect(servedCounts(json, findings)).toEqual(served.counts);
    // The imported high finding is open; the high rule finding is intended.
    expect(served.counts).toEqual({ byVerdict: { eyes: 1, risky: 1, spec: 0, ok: 1, same: 1 }, openHigh: 1 });
  });

  it('openHigh counts open high findings of the served Report: rule and imported, merged once, on files in the change', () => {
    const json = JSON.stringify(withRule());
    const twice = [stored(), stored({ source: 'semgrep' })];
    const gone = stored({ file: ORDERS, line: 12, title: 'Order lost' });
    const withoutOrders = { ...withRule(), findings: [], packages: withRule().packages.map((pkg) => ({ ...pkg, files: pkg.files.filter((entry) => entry.path !== ORDERS) })) };
    expect(servedCounts(json, { stored: twice, ruleStates: {} })?.openHigh).toBe(2);
    expect(servedCounts(json, { stored: [stored({ severity: 'med' })], ruleStates: {} })?.openHigh).toBe(1);
    expect(servedCounts(JSON.stringify(withoutOrders), { stored: [gone], ruleStates: {} })?.openHigh).toBe(0);
    expect(reportCounts({ findings: [RULE, { ...RULE, id: 'rule:size:0002', state: 'fixed' }], summary: withRule().summary }).openHigh).toBe(1);
  });

  it('with nothing to overlay: the stored string, no counts, and the Report is not parsed', () => {
    const notJson = 'not a report';
    const none = { stored: [], ruleStates: {} };
    expect(hasOverlay(none)).toBe(false);
    expect(serveOverlay(notJson, none)).toEqual({ body: notJson, counts: null });
    expect(servedCounts(notJson, none)).toBeNull();
    expect(hasOverlay({ stored: [], ruleStates: { [RULE.id]: 'open' } })).toBe(true);
  });

  it('servedStats moves only filesByVerdict, and copies it', () => {
    const stats = {
      touchedFiles: 3,
      symbolsByStatus: { add: 0, mod: 3, sig: 0, del: 0, same: 1 },
      filesByVerdict: { eyes: 1, risky: 0, spec: 0, ok: 2, same: 1 },
      tier1Files: ['src/orders/orders.service.ts'],
    };
    const byVerdict = { eyes: 1, risky: 2, spec: 0, ok: 0, same: 1 };
    const listed = servedStats(stats, byVerdict);
    expect(listed).toEqual({ ...stats, filesByVerdict: byVerdict });
    expect(listed.filesByVerdict).not.toBe(byVerdict);
    expect(stats.filesByVerdict.risky).toBe(0);
  });

  it('servedRepoSummary adds the openHigh of each overlaid change to the stored part', () => {
    const repo = {
      id: 1, name: 'shopfront', path: '/work/shopfront', active: true, lastSeenAt: '2026-09-01T10:00:00.000Z', lastEventAt: null,
      counts: { draft: 0, branch: 3, pr: 0 }, unreviewed: 3, highFindings: 0, lastAudit: null, archivedCount: 0,
      collecting: false, error: null, watch: 'full' as const, notes: [],
    };
    const counts = (openHigh: number) => ({ byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 }, openHigh });
    expect(servedRepoSummary(repo, [counts(2), counts(0), counts(1)]).highFindings).toBe(3);
    expect(servedRepoSummary(repo, [])).toEqual(repo);
  });
});

describe('why overrides (DC-106)', () => {
  const ROUTE = `${CONTROLLER}#cancelRoute`;
  const CANCEL = `${ORDERS}#OrdersService.cancel`;

  /** The shopfront Report with a reading path: the route, then the service method. */
  function withSteps(): Report {
    return {
      ...shopfrontReport(),
      steps: [
        { order: 1, symbolId: ROUTE, fileId: CONTROLLER, why: 'New function', diff: [], section: 'path', entry: ROUTE },
        { order: 2, symbolId: CANCEL, fileId: ORDERS, why: 'Body changed', diff: [], section: 'path', entry: ROUTE },
      ],
    };
  }

  const steps = (json: string, findings: StoredFinding[]): string[] =>
    (JSON.parse(serveReport(json, { stored: findings, ruleStates: {} })) as Report).steps.map((step) => step.why);

  it("an open imported finding's why hint replaces the why of its symbol's step; the stored Report is untouched", () => {
    const json = JSON.stringify(withSteps());
    const hinted = { ...stored(), why: 'new route, called without an order' };
    expect(steps(json, [hinted])).toEqual(['new route, called without an order', 'Body changed']);
    expect(JSON.parse(json)).toEqual(withSteps());
  });

  it('the first hint of a finding that is not fixed wins on a symbol, in import order; intended keeps its hint, fixed and hintless change nothing', () => {
    const json = JSON.stringify(withSteps());
    const first = { ...stored({ title: 'First' }), why: 'first hint' };
    const second = { ...stored({ title: 'Second' }), why: 'second hint' };
    expect(steps(json, [first, second])).toEqual(['first hint', 'Body changed']);
    expect(steps(json, [second, first])).toEqual(['second hint', 'Body changed']);

    const fixed = { ...first, finding: { ...first.finding, state: 'fixed' as const } };
    const intended = { ...first, finding: { ...first.finding, state: 'intended' as const } };
    expect(steps(json, [intended])).toEqual(['first hint', 'Body changed']);
    expect(steps(json, [intended, second])).toEqual(['first hint', 'Body changed']);
    expect(steps(json, [fixed])).toEqual(['New function', 'Body changed']);
    expect(steps(json, [fixed, second])).toEqual(['second hint', 'Body changed']);
    expect(steps(json, [stored()])).toEqual(['New function', 'Body changed']);
  });

  it('the hint follows the re-anchored symbol: a finding on the service method hints its step', () => {
    const json = JSON.stringify(withSteps());
    const onCancel = { ...stored({ file: ORDERS, line: 12, title: 'Cancel ignores refunds' }), why: 'cancel no longer refunds' };
    expect(steps(json, [onCancel])).toEqual(['New function', 'cancel no longer refunds']);
  });
});

describe('resolveFinding', () => {
  it('a rule finding of the Report, with its state applied', () => {
    expect(resolveFinding(withRule(), { stored: [], ruleStates: {} }, RULE.id)).toEqual({ origin: 'rule', finding: RULE });
    expect(resolveFinding(withRule(), { stored: [], ruleStates: { [RULE.id]: 'intended' } }, RULE.id)).toEqual({
      origin: 'rule',
      finding: { ...RULE, state: 'intended' },
    });
  });

  it('an imported finding merged with another source: every part, by either key', () => {
    const first = stored();
    const second = stored({ source: 'semgrep', line: 12, severity: 'med', title: 'cancel without an order.' });
    const other = stored({ title: 'Unrelated', line: 9 });
    const findings = { stored: [first, other, second], ruleStates: {} };
    for (const key of [first.key, second.key]) {
      const resolved = resolveFinding(shopfrontReport(), findings, key);
      expect(resolved).toMatchObject({
        origin: 'import',
        finding: { id: first.key, sources: ['claude', 'semgrep'], severity: 'high' },
        parts: [
          { key: first.key, state: 'open' },
          { key: second.key, state: 'open' },
        ],
      });
    }
  });

  it('a finding whose file left the change is its own part', () => {
    const gone = stored();
    const report = shopfrontReport();
    report.packages = report.packages.map((pkg) => ({ ...pkg, files: pkg.files.filter((f) => f.path !== CONTROLLER) }));
    expect(resolveFinding(report, { stored: [gone], ruleStates: {} }, gone.key)).toEqual({
      origin: 'import',
      finding: gone.finding,
      parts: [{ key: gone.key, state: 'open' }],
    });
  });

  it('an unknown key, or a rule id the Report no longer has, is null', () => {
    expect(resolveFinding(shopfrontReport(), { stored: [stored()], ruleStates: {} }, 'f:ffffffffffffffff')).toBeNull();
    expect(resolveFinding(shopfrontReport(), { stored: [], ruleStates: { [RULE.id]: 'intended' } }, RULE.id)).toBeNull();
  });
});

describe('stateTargets', () => {
  it('every part that is not fixed; every part when all are fixed', () => {
    expect(stateTargets([{ key: 'a', state: 'open' }, { key: 'b', state: 'fixed' }, { key: 'c', state: 'intended' }])).toEqual(['a', 'c']);
    expect(stateTargets([{ key: 'a', state: 'fixed' }, { key: 'b', state: 'fixed' }])).toEqual(['a', 'b']);
  });
});
