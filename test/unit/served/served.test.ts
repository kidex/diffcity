// The served Report and the finding a findings action names (ADR-036).

import { describe, expect, it } from 'vitest';
import { anchor, type FindingInput, type StoredFinding } from '../../../src/core/findings/index.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { resolveFinding, serveReport, stateTargets } from '../../../src/core/served/index.js';
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
