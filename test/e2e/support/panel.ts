// Fixture Reports and helpers for the reading panel's specs (T8). The Reports
// are the golden order-discounts Report (invented names) with an execution
// path, findings of several sources (one change-level, one fixed) and spec
// verdicts (`inSpec` true, false and null) added: the golden Report has
// neither steps nor findings.

import type { Locator, Page } from '@playwright/test';
import type { DiffLine, Finding, Report, Step } from '../../../src/core/report/types.js';
import { CONTROLLER, finding, GUARD, MIGRATION, SERVICE } from './hud.js';
import type { ApiData } from './mock-api.js';
import { fixtures, mockApi } from './mock-api.js';
import { openCity } from './scene.js';

export const MAILER = 'src/services/orders/mailer.ts';
export const DISCOUNT = 'src/services/orders/discount.rules.ts';

export const sym = (file: string, name: string): string => `${file}#${name}`;

export const PLACE = sym(SERVICE, 'OrdersService.place');
export const APPLY = sym(SERVICE, 'OrdersService.applyDiscount');
export const CAN_PLACE = sym(GUARD, 'OrderGuard.canPlace');
export const ALTER = sym(MIGRATION, 'ALTER TABLE orders');
export const SEND = sym(MAILER, 'send');

function step(order: number, fileId: string, symbolId: string, why: string, diff: DiffLine[]): Step {
  return { order, fileId, symbolId, why, diff };
}

/** Five stops in reading order: the guard, the service twice, the migration, the mailer. */
export function stopsFixture(): Step[] {
  return [
    step(1, GUARD, CAN_PLACE, 'The entry point: the guard now also checks the owner.', [
      { kind: 'ctx', text: 'canPlace(user: User, order: Order): boolean {' },
      { kind: 'del', text: '  return user.active;' },
      { kind: 'add', text: '  return user.active && order.owner === user.id;' },
      { kind: 'ctx', text: '}' },
    ]),
    step(2, SERVICE, PLACE, 'Place now validates the discount before saving.', [
      { kind: 'add', text: 'const total = this.applyDiscount(order);' },
      { kind: 'ctx', text: 'await this.repo.insert(order, total);' },
    ]),
    step(3, SERVICE, APPLY, 'The new discount calculation.', [{ kind: 'add', text: 'return rules.reduce((sum, rule) => rule.apply(sum), order.total);' }]),
    step(4, MIGRATION, ALTER, 'The column the discount is stored in.', [{ kind: 'add', text: 'ALTER TABLE orders ADD COLUMN discount_cents INTEGER;' }]),
    // A stop without an excerpt.
    step(5, MAILER, SEND, 'The confirmation mail mentions the discount.', []),
  ];
}

/** The golden Report with stops, findings and spec verdicts for the panel. */
export function panelReport(): Report {
  const report = fixtures.reportGolden();
  report.steps = stopsFixture();
  const findings: Finding[] = [
    finding('cl-1', 'claude', '', { title: 'Scope is wider than asked', message: 'The change also touches the mailer.', severity: 'high' }),
    finding('g-1', 'claude', GUARD, { severity: 'high', category: 'security', title: 'Guard skips the owner check on cancel', symbolId: CAN_PLACE, line: 14 }),
    finding('s-1', 'semgrep', SERVICE, { severity: 'med', title: 'Total is not rounded', symbolId: PLACE, line: 31 }),
    finding('s-2', 'eslint', SERVICE, { severity: 'low', title: 'Unused import', state: 'fixed', line: 2 }),
    finding('m-1', 'claude', MAILER, { severity: 'low', title: 'Template is not escaped', line: 9 }),
  ];
  report.findings = findings;
  for (const file of report.packages.flatMap((pkg) => pkg.files)) {
    file.inSpec = file.id === MAILER || file.id === DISCOUNT ? false : file.id === CONTROLLER ? null : true;
  }
  return report;
}

/** The panel Report without a spec: `inSpec` is null everywhere. */
export function noSpecReport(): Report {
  const report = panelReport();
  for (const file of report.packages.flatMap((pkg) => pkg.files)) file.inSpec = null;
  return report;
}

/** The panel Report without an execution path. */
export function noStepsReport(): Report {
  const report = panelReport();
  report.steps = [];
  return report;
}

/** Opens change 11 with `report`, reduced motion, the city drawn. Returns the Reports the API answers with: set `[11]` to serve another one. */
export async function openPanel(page: Page, report: Report = panelReport(), api: Partial<ApiData> = {}): Promise<Record<number, Report>> {
  const reports: Record<number, Report> = { 11: report };
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await mockApi(page, { ...api, reports });
  await openCity(page);
  return reports;
}

export const panel = (page: Page): Locator => page.getByTestId('reading-panel');
export const tab = (page: Page, id: 'order' | 'findings' | 'outside' | 'symbols'): Locator => page.getByTestId(`tab-${id}`);
export const stopCards = (page: Page): Locator => page.getByTestId('stop-card');

const byTestId = (testId: string): string => JSON.stringify(`[data-testid="${testId}"]`);

/** The `name` attribute of every element with `data-testid`, in order. The test tsconfig has no DOM types, so the script is a string. */
export const attributesOf = (page: Page, testId: string, name: string): Promise<(string | null)[]> =>
  page.evaluate<(string | null)[]>(`[...document.querySelectorAll(${byTestId(testId)})].map((node) => node.getAttribute(${JSON.stringify(name)}))`);

/** The tab list's scroll offset, and how far it can scroll. */
export const tabScroll = (page: Page): Promise<number> => page.evaluate<number>(`document.querySelector(${byTestId('panel-scroll')}).scrollTop`);
export const tabOverflow = (page: Page): Promise<number> =>
  page.evaluate<number>(`(() => { const node = document.querySelector(${byTestId('panel-scroll')}); return node.scrollHeight - node.clientHeight; })()`);
export const scrollTabTo = (page: Page, top: number): Promise<unknown> =>
  page.evaluate(`document.querySelector(${byTestId('panel-scroll')}).scrollTop = ${String(top)}`);
