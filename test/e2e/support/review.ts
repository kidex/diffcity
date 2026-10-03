// Helpers for the review marks' specs (T10, ADR-028): opening the golden
// change with the mock API's review routes, finding the mark buttons, the
// dialogs and the progress, and, for proofs against the real daemon, writing a
// mark from the page the way the screen does.

import type { Locator, Page } from '@playwright/test';
import type { ReviewMark } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { GUARD } from './hud.js';
import type { ApiData, MockedApi } from './mock-api.js';
import { mockApi } from './mock-api.js';
import { panelReport, PLACE } from './panel.js';
import { project, sceneExpect as expect, openCity, waitForCityAttribute } from './scene.js';

export { PLACE };

/** What `openReview` hands back. */
export interface ReviewPage {
  api: MockedApi;
  report: Report;
}

/** Opens change 11 (the panel Report: stops, findings) with reduced motion and the review routes mocked; `seed` marks and `api` overrides are optional. */
export async function openReview(
  page: Page,
  options: { report?: Report; marks?: ReviewMark[]; note?: string | null; api?: Partial<ApiData>; wait?: boolean } = {},
): Promise<ReviewPage> {
  const report = options.report ?? panelReport();
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const api = await mockApi(page, {
    ...options.api,
    reports: { 11: report },
    review: { marks: options.marks ?? [], note: options.note ?? null },
  });
  if (options.wait !== false) await openCity(page);
  return { api, report };
}

/** Clicks the centre of a building (or of one floor) and waits for the selection. */
export async function selectFile(page: Page, fileId: string = GUARD, symbolId?: string): Promise<void> {
  const point = await project(page, fileId, symbolId);
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', fileId);
}

export const card = (page: Page): Locator => page.getByTestId('selection-card');
export const fileView = (page: Page): Locator => page.getByTestId('file-view');
export const progress = (page: Page): Locator => page.getByTestId('progress');
export const rewriteDialog = (page: Page): Locator => page.getByTestId('rewrite-dialog');
export const summaryDialog = (page: Page): Locator => page.getByTestId('summary-dialog');

/** The mark buttons of the selection card. */
export const cardButton = (page: Page, name: 'checked' | 'good' | 'rewrite' | 'undo'): Locator => card(page).getByTestId(`mark-${name}`);
/** The mark buttons of the file view's header. */
export const viewButton = (page: Page, name: 'checked' | 'good' | 'rewrite' | 'undo'): Locator => fileView(page).getByTestId(`mark-${name}`);

/** The mark a request body carries, as the route saw it. */
export const lastWrite = (api: MockedApi) => api.review(11).writes[api.review(11).writes.length - 1];

/** Waits for the progress headline. */
export async function expectProgress(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId('progress-attention')).toHaveText(text);
}

/**
 * Writes a mark from the page, as the screen does (same origin, JSON), for a
 * proof against the real daemon: reads the latest snapshot id first.
 */
export async function markInPage(
  page: Page,
  changeId: number,
  target: { kind: 'file' | 'symbol'; id: string },
  mark: 'checked' | 'good' | 'rewrite',
  note?: string,
): Promise<void> {
  await page.evaluate(`(async () => {
    const base = '/api/changes/${String(changeId)}/review';
    const state = await (await fetch(base)).json();
    const response = await fetch(base + '/marks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: state.snapshotId, target: ${JSON.stringify(target)}, mark: ${JSON.stringify(mark)}, ${note === undefined ? '' : `note: ${JSON.stringify(note)}`} }),
    });
    if (!response.ok) throw new Error('mark refused: ' + response.status);
  })()`);
}
