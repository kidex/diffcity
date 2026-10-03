// Fixture Reports and helpers for the change screen's HUD specs. The Reports
// are the golden order-discounts Report (invented names) with rule findings,
// rule checks and change-level findings added; `checks` is optional in the
// data model (SPEC.md section 4.1) and the core type does not declare it yet,
// so it is attached through a cast.

import type { Page } from '@playwright/test';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { fixtures } from './mock-api.js';

export const GUARD = 'src/auth/order.guard.ts';
export const MIGRATION = 'db/migrations/20260921_order_discounts.sql';
export const SERVICE = 'src/services/orders/orders.service.ts';
export const REPO = 'src/repo/orders.repo.ts';
export const CONTROLLER = 'src/api/orders/orders.controller.ts';

export interface CheckSeed {
  ruleId: string;
  kind: string;
  state: string;
  reason?: string;
  findings: number;
  checkedAt: string;
}

export function finding(id: string, source: string, file: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    source,
    severity: 'med',
    category: 'scope',
    file,
    line: file === '' ? 0 : 12,
    title: `Finding ${id}`,
    message: `Message of ${id}`,
    state: 'open',
    ...overrides,
  };
}

export function withChecks(report: Report, checks: CheckSeed[]): Report {
  (report as unknown as { checks: CheckSeed[] }).checks = checks;
  return report;
}

const CHECKED_AT = '2026-05-04T11:19:30.000Z';

/** The golden Report with two rules violated on files (layers twice, file-size once), one other finding on the guard, and the checks of four rules. */
export function ruleReport(): Report {
  const report = fixtures.reportGolden();
  report.findings = [
    finding('rule-1', 'rule:file-size', SERVICE, { title: 'File is too long', category: 'style' }),
    finding('rule-2', 'rule:layers', REPO, { title: 'Repo imports the controller layer' }),
    finding('rule-3', 'rule:layers', CONTROLLER, { title: 'Controller imports the repo layer' }),
    finding('claude-1', 'claude', GUARD, { severity: 'high', category: 'security', title: 'Guard skips the owner check' }),
  ];
  return withChecks(report, [
    { ruleId: 'file-size', kind: 'file-size', state: 'violations', findings: 1, checkedAt: CHECKED_AT },
    { ruleId: 'layers', kind: 'layers', state: 'violations', findings: 2, checkedAt: CHECKED_AT },
    { ruleId: 'deps', kind: 'cve', state: 'not-checked', reason: 'no network', findings: 0, checkedAt: CHECKED_AT },
    { ruleId: 'format', kind: 'pipeline', state: 'passed', findings: 0, checkedAt: CHECKED_AT },
  ]);
}

/** The golden Report whose CI pipeline rule failed with a change-level finding. */
export function ciFailedReport(): Report {
  const report = fixtures.reportGolden();
  report.findings = [finding('ci-1', 'rule:ci', '', { severity: 'high', title: 'Pipeline failed', category: 'tests' })];
  return withChecks(report, [{ ruleId: 'ci', kind: 'pipeline', state: 'violations', findings: 1, checkedAt: CHECKED_AT }]);
}

/** The golden Report with two change-level findings that are not a pipeline. */
export function changeLevelReport(): Report {
  const report = fixtures.reportGolden();
  report.findings = [finding('cl-1', 'claude', '', { title: 'Scope is wider than asked' }), finding('cl-2', 'semgrep', '', { title: 'Lockfile changed' })];
  return report;
}

/** What the filters dim, as the scene reports it. */
export interface PaintDump {
  dimmed: string[];
  floors: Record<string, number[]>;
}

export const paintDump = (page: Page): Promise<PaintDump> => page.evaluate<PaintDump>('window.diffcityScene.paint()');

/** Every building of `report`, with its floors' statuses in the scene's order (source order). */
export function floorStatuses(report: Report): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const file of report.packages.flatMap((pkg) => pkg.files)) {
    const symbols = [...file.symbols].sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || a.id.localeCompare(b.id));
    map.set(file.id, symbols.length === 0 ? [file.status] : symbols.map((symbol) => symbol.status));
  }
  return map;
}
