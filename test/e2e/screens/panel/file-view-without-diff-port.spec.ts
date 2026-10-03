// e2e/panel/file-view-without-diff-port (ADR-002, ADR-027): mounted as the
// HTML export mounts it, with no DiffPort, the file view shows the Report's
// step diffs and says "Full diff is available in the app". With a DiffPort the
// same excerpts stay and the mount point for the full diff is there instead of
// that sentence.

import { test } from '@playwright/test';
import { SERVICE } from '../../support/hud.js';
import { project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { openPanel } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/file-view-without-diff-port', async ({ page }) => {
  await page.addInitScript('window.diffcityNoDiffs = true');
  await openPanel(page);
  const service = await project(page, SERVICE);
  await page.mouse.click(service.x, service.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  const area = page.getByTestId('file-diff');
  await expect(area).toBeVisible();
  const excerpts = area.getByTestId('diff-excerpt');
  await expect(excerpts).toHaveCount(2);
  await expect(excerpts.nth(0)).toContainText('OrdersService.place');
  await expect(excerpts.nth(0)).toContainText('await this.repo.insert(order, total);');
  await expect(excerpts.nth(1)).toContainText('OrdersService.applyDiscount');
  await expect(area.getByTestId('diff-in-app')).toHaveText('Full diff is available in the app');
  await expect(area.getByTestId('diff-mount')).toHaveCount(0);
});

test('panel/file-view-with-diff-port', async ({ page }) => {
  await openPanel(page);
  const service = await project(page, SERVICE);
  await page.mouse.click(service.x, service.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  const area = page.getByTestId('file-diff');
  await expect(area.getByTestId('diff-excerpt')).toHaveCount(2);
  await expect(area.getByTestId('diff-mount')).toHaveCount(1);
  await expect(area.getByTestId('diff-mount')).toHaveAttribute('data-file', SERVICE);
  await expect(area.getByTestId('diff-in-app')).toHaveCount(0);
});
