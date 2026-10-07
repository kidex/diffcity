// e2e/findings/live-refresh (DC-108, ADR-036): SSE `findings` for the open
// change refetches its Report (an import, a state set from another tab, a
// queued fix), and the screen keeps what the reviewer was doing: the camera,
// the selection, the filters, the open file view and its scroll. An event for
// another change refetches nothing.

import { test } from '@playwright/test';
import { HIGH, openFindings, pinsOn, SERVICE } from '../../support/findings.js';
import { setFindingState } from '../../support/findings-api.js';
import { camera, project, selected, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

const fileScroll = `document.querySelector('[data-testid="file-view-scroll"]')`;

test('findings/live-refresh/findings-event-refetches-keeps-view', async ({ page }, testInfo) => {
  const { api, reports } = await openFindings(page, { wait: false });
  await tagClient(page, testInfo.testId);
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  // Orbit and zoom, filter by type, open the service's file view and scroll it.
  const canvas = page.getByTestId('city-canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 3 + 50, box.y + box.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  await page.mouse.wheel(0, -100);
  await page.getByTestId('filter-type-add').click();
  const service = await project(page, SERVICE);
  await page.mouse.click(service.x, service.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  const view = page.getByTestId('file-view');
  await expect(view.getByTestId('file-view-file')).toHaveText(SERVICE);
  await page.evaluate(`${fileScroll}.scrollTop = 120`);
  const scrolled = await page.evaluate<number>(`${fileScroll}.scrollTop`);
  expect(scrolled).toBeGreaterThan(0);
  const filters = await page.getByTestId('city').getAttribute('data-filters');
  expect(filters).toContain('type=add');
  const before = await camera(page);
  const card = view.locator(`[data-testid="finding"][data-finding="${HIGH}"]`);
  await expect(card).toHaveAttribute('data-state', 'open');

  // Another change's event: nothing is fetched.
  const reads = api.count('/api/changes/11/report');
  await emitSse(page, testInfo.testId, 'findings', { repoId: 1, changeId: 99 });
  await page.waitForTimeout(800);
  expect(api.count('/api/changes/11/report')).toBe(reads);

  // Someone marked the high finding as intended elsewhere: the daemon serves the new Report and says so.
  const served = reports[11];
  if (served === undefined) throw new Error('no Report for change 11');
  setFindingState(served, HIGH, 'intended');
  expect(await emitSse(page, testInfo.testId, 'findings', { repoId: 1, changeId: 11 })).toBeGreaterThan(0);
  await expect.poll(() => api.count('/api/changes/11/report')).toBe(reads + 1);
  await expect(card).toHaveAttribute('data-state', 'intended');
  await expect.poll(() => pinsOn(page, SERVICE)).not.toContain('high');
  await expect(view.getByTestId('file-view-verdict')).toHaveClass(/\bok\b/);

  // The view is as it was.
  expect(await camera(page)).toEqual(before);
  expect(await selected(page)).toBe(SERVICE);
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', filters ?? '');
  await expect(page.getByTestId('filter-type-add')).toHaveAttribute('aria-pressed', 'true');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('file-view-file')).toHaveText(SERVICE);
  expect(await page.evaluate<number>(`${fileScroll}.scrollTop`)).toBe(scrolled);
  // No Undo: this session did not mark it.
  await expect(card.locator('button')).toHaveCount(0);
});
