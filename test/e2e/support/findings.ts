// Helpers for the finding actions' specs (DC-108, ADR-036): the mixed
// findings Report (test/fixtures/ui/report-findings-mixed.json), opening it
// with the findings routes mocked, and the cards and buttons of one finding.

import type { Locator, Page } from '@playwright/test';
import type { Report } from '../../../src/core/report/types.js';
import { effects } from './effects.js';
import type { ApiData, MockedApi } from './mock-api.js';
import { fixtures, mockApi } from './mock-api.js';
import { openCity } from './scene.js';

export const SERVICE = 'src/services/orders/orders.service.ts';
export const CONTROLLER = 'src/api/orders/orders.controller.ts';
export const MAILER = 'src/services/orders/mailer.ts';
export const REPO = 'src/repo/orders.repo.ts';
export const DTO = 'src/api/orders/orders.dto.ts';

/** The open high finding on OrdersService.place, from claude and semgrep: it makes the service risky. */
export const HIGH = 'f:1a2b3c4d5e6f7a81';
export const HIGH_TITLE = 'Discount is applied twice on a retried order';
/** An open medium finding on OrdersService.calcTotal. */
export const MED = 'f:2b3c4d5e6f7a8192';
/** The open rule finding on the controller (`:` in its id). */
export const RULE = 'rule:file-size:7d3e9a10';
export const INTENDED = 'f:3c4d5e6f7a8192a3';
export const FIXED = 'f:4d5e6f7a8192a3b4';

export const mixedReport = (): Report => fixtures.reportFindingsMixed();

/** Opens change 11 with `report` (the mixed one by default), reduced motion and the city drawn. */
export async function openFindings(
  page: Page,
  options: { report?: Report; api?: Partial<ApiData>; wait?: boolean } = {},
): Promise<{ api: MockedApi; reports: Record<number, Report> }> {
  const reports: Record<number, Report> = { 11: options.report ?? mixedReport() };
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const api = await mockApi(page, { ...options.api, reports });
  if (options.wait !== false) await openCity(page);
  return { api, reports };
}

/** The cards of finding `id` in `scope` (the Findings tab's body by default). */
export const cardIn = (scope: Locator, id: string): Locator => scope.locator(`[data-testid="finding"][data-finding="${id}"]`);
export const findingsTab = (page: Page): Locator => page.getByTestId('tab-findings-body');
export const tabCard = (page: Page, id: string): Locator => cardIn(findingsTab(page), id);

export const askButton = (card: Locator): Locator => card.getByTestId('finding-ask');
export const intendButton = (card: Locator): Locator => card.getByTestId('finding-intend');
export const undoButton = (card: Locator): Locator => card.getByTestId('finding-undo');

/** The open pins the city draws on `file`, by severity. */
export async function pinsOn(page: Page, file: string): Promise<string[]> {
  return (await effects(page)).markers.filter((marker) => marker.kind === 'pin' && marker.file === file).map((marker) => String(marker.severity));
}

/** Whether the city pulses floors of `file` (a risky or eyes file, or an open high finding). */
export async function pulses(page: Page, file: string): Promise<boolean> {
  return (await effects(page)).pulse[file] !== undefined;
}

/** The number on the verdict filter chip `verdict`. */
export const verdictCount = (page: Page, verdict: string): Locator => page.getByTestId(`filter-verdict-${verdict}`).locator('b');
