// findings-model (ADR-036): what a finding card shows of its sources and its
// actions. Findings by file and by state with every source kept, the sources
// of a merged entry, and which buttons a card offers from the Report's state
// and what the session did. The fixture's verdicts are what fileVerdict gives.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { fileVerdict } from '../../../src/core/verdict/index.js';
import type { FindingSession } from '../../../src/ui/screens/change/model/findings.js';
import { actionName, actionsView, emptySession, sourcesOf } from '../../../src/ui/screens/change/model/findings.js';
import { findingGroups, findingSources } from '../../../src/ui/screens/change/model/panel.js';

const mixed = (): Report => JSON.parse(readFileSync(new URL('../../fixtures/ui/report-findings-mixed.json', import.meta.url), 'utf8')) as Report;

const SERVICE = 'src/services/orders/orders.service.ts';
const HIGH = 'f:1a2b3c4d5e6f7a81';
const MED = 'f:2b3c4d5e6f7a8192';
const RULE = 'rule:file-size:7d3e9a10';
const INTENDED = 'f:3c4d5e6f7a8192a3';
const FIXED = 'f:4d5e6f7a8192a3b4';

const session = (patch: Partial<FindingSession> = {}): FindingSession => ({ ...emptySession(), ...patch });
const labels = (finding: Pick<Finding, 'id' | 'state'>, state: FindingSession): string[] => actionsView(finding, state).buttons.map((b) => `${b.label}${b.disabled ? ' (inert)' : ''}`);

describe('findings-model', () => {
  it('group-and-sort-with-sources', () => {
    const report = mixed();
    const groups = findingGroups(report);
    // By file in the Report's order; within a file open first, then the more severe.
    expect(groups.map((group) => group.path)).toEqual(['src/api/orders/orders.controller.ts', 'src/repo/orders.repo.ts', 'src/services/orders/mailer.ts', SERVICE]);
    expect(groups.map((group) => group.findings.map((finding) => finding.id))).toEqual([[RULE], [FIXED], [INTENDED], [HIGH, MED]]);
    // Every source of an entry, the primary one first; a rule finding without `sources` has its own.
    const service = groups.find((group) => group.path === SERVICE)?.findings ?? [];
    expect(service.map(sourcesOf)).toEqual([['claude', 'semgrep'], ['semgrep']]);
    expect(sourcesOf(groups[0]?.findings[0] ?? { source: '' })).toEqual(['rule:file-size']);
    // A merged entry lists each source once, `source` first, whatever order `sources` has.
    expect(sourcesOf({ source: 'semgrep', sources: ['claude', 'semgrep', 'claude', 'eslint'] })).toEqual(['semgrep', 'claude', 'eslint']);
    // The footer names every source of the Report, merged ones included, once each.
    expect(findingSources(report)).toEqual(['claude', 'semgrep', 'rule:file-size', 'eslint']);
  });

  it('fixture-verdicts-match-the-daemon', () => {
    const report = mixed();
    const tier1 = new Set(report.summary.tier1Files);
    const counts = { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 };
    for (const file of report.packages.flatMap((pkg) => pkg.files)) {
      const verdict = fileVerdict({
        status: file.status,
        symbolStatuses: file.symbols.map((symbol) => symbol.status),
        tier1: tier1.has(file.path),
        findings: report.findings.filter((finding) => finding.file === file.path),
        inSpec: file.inSpec,
      });
      expect(file.verdict, file.path).toBe(verdict);
      counts[verdict] += 1;
    }
    expect(report.summary.byVerdict).toEqual(counts);
    expect(report.packages.flatMap((pkg) => pkg.files).find((file) => file.path === SERVICE)?.verdict).toBe('risky');
  });

  it('open-offers-ask-and-mark', () => {
    expect(labels({ id: HIGH, state: 'open' }, session())).toEqual(['Ask agent to fix', 'Mark as intended']);
    expect(labels({ id: HIGH, state: 'open' }, session({ queued: new Set([HIGH]) }))).toEqual(['Queued (inert)', 'Mark as intended']);
    expect(labels({ id: HIGH, state: 'open' }, session({ pending: new Map([[HIGH, 'ask']]) }))).toEqual(['Ask agent to fix (inert)', 'Mark as intended (inert)']);
    expect(labels({ id: HIGH, state: 'open' }, session({ expected: new Map([[HIGH, 'intended']]) }))).toEqual(['Ask agent to fix (inert)', 'Mark as intended (inert)']);
  });

  it('intended-offers-undo-for-the-session-only', () => {
    expect(labels({ id: INTENDED, state: 'intended' }, session())).toEqual([]);
    expect(labels({ id: INTENDED, state: 'intended' }, session({ marked: new Set([INTENDED]) }))).toEqual(['Undo']);
    expect(labels({ id: FIXED, state: 'fixed' }, session({ marked: new Set([FIXED]), queued: new Set([FIXED]) }))).toEqual([]);
  });

  it('error-line-and-names', () => {
    const view = actionsView({ id: RULE, state: 'open' }, session({ errors: new Map([[RULE, 'The fix queue is not safe to write.']]) }));
    expect(view.error).toBe('The fix queue is not safe to write.');
    expect(view.buttons.map((button) => actionName(button, 'File is over the size limit'))).toEqual([
      'Ask agent to fix: File is over the size limit',
      'Mark as intended: File is over the size limit',
    ]);
    expect(actionName({ action: 'undo', label: 'Undo', disabled: false }, 'T')).toBe('Undo mark as intended: T');
  });
});
