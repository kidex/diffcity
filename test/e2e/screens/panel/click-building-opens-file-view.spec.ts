// e2e/panel/click-building-opens-file-view: a click on a building selects it
// and opens the file view in the right panel in place of the tabs: the file,
// its package, its verdict, the counts by status, the file's stops and the
// diff area. A click on another building switches the file view; a stop card
// in the tabs opens it too.

import { test } from '@playwright/test';
import { GUARD, SERVICE } from '../../support/hud.js';
import { project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { DISCOUNT, openPanel, stopCards, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/click-building-opens-file-view', async ({ page }) => {
  await openPanel(page);
  const view = page.getByTestId('file-view');
  await expect(view).toBeHidden();

  const guard = await project(page, GUARD);
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(view).toBeVisible();
  await expect(page.getByTestId('tab-order')).toBeHidden();
  await expect(view.getByTestId('file-view-file')).toHaveText(GUARD);
  await expect(view.getByTestId('file-view-package')).toHaveText('src/auth');
  await expect(view.getByTestId('file-view-verdict')).toHaveText('Needs your eyes');
  await expect(view.getByTestId('file-view-tier')).toHaveText('tier 1');
  await expect(view.getByTestId('file-view-counts')).toHaveText('+0 added0 modified1 sig0 removed');
  // The file's stops, then the diff area.
  await expect(view.getByTestId('stop-card')).toHaveCount(1);
  await expect(view.getByTestId('stop-card').getByTestId('stop-symbol')).toHaveText('OrderGuard.canPlace');
  await expect(view.getByTestId('file-diff')).toBeVisible();
  // The HUD selection card follows the same selection.
  await expect(page.getByTestId('selection-card').getByTestId('card-file')).toHaveText(GUARD);

  // Another building replaces the file view.
  const service = await project(page, SERVICE);
  await page.mouse.click(service.x, service.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  await expect(view.getByTestId('file-view-file')).toHaveText(SERVICE);
  await expect(view.getByTestId('stop-card')).toHaveCount(2);

  // A file with no stop says so.
  const discount = await project(page, DISCOUNT);
  await page.mouse.click(discount.x, discount.y);
  await waitForCityAttribute(page, 'data-selected', DISCOUNT);
  await expect(view.getByTestId('file-view-file')).toHaveText(DISCOUNT);
  await expect(view.getByTestId('stop-card')).toHaveCount(0);
  await expect(view.getByTestId('file-view-no-stops')).toBeVisible();
  await page.getByTestId('file-view-back').click();

  // A stop card in the tabs opens the file view of its file.
  await expect(tab(page, 'order')).toBeVisible();
  await stopCards(page).nth(1).click();
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  await expect(view.getByTestId('file-view-file')).toHaveText(SERVICE);
});
