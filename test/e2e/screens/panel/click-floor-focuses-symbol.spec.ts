// e2e/panel/click-floor-focuses-symbol: a click on a floor of a building
// focuses that floor's symbol: the city, the HUD selection card and the file
// view name the same symbol, and the diff area carries it for the full diff to
// open at. A stop card in the file view focuses its own symbol.

import { test } from '@playwright/test';
import { SERVICE } from '../../support/hud.js';
import { project, selectedFloor, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { APPLY, openPanel, PLACE } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/click-floor-focuses-symbol', async ({ page }) => {
  await openPanel(page);
  const view = page.getByTestId('file-view');
  const floor = await project(page, SERVICE, APPLY);
  await page.mouse.click(floor.x, floor.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  await expect(view).toBeVisible();

  // The floor under the pointer is a floor of the service, and every part follows it.
  const focused = await selectedFloor(page);
  expect(focused).not.toBeNull();
  expect(focused?.startsWith(`${SERVICE}#`)).toBe(true);
  await expect(page.getByTestId('city')).toHaveAttribute('data-selected-floor', focused ?? '');
  await expect(view.getByTestId('file-diff')).toHaveAttribute('data-focus-symbol', focused ?? '');
  const name = (focused ?? '').slice(SERVICE.length + 1);
  await expect(page.getByTestId('selection-card').locator('li.focus .sym')).toHaveText(name);

  // A stop of the file focuses its symbol.
  await view.locator(`[data-testid="stop-card"][data-symbol="${PLACE}"]`).click();
  await expect.poll(() => selectedFloor(page)).toBe(PLACE);
  await expect(view.getByTestId('file-diff')).toHaveAttribute('data-focus-symbol', PLACE);
  await expect(view.locator(`[data-testid="stop-card"][data-symbol="${PLACE}"]`)).toHaveClass(/\bon\b/);
  await expect(view.locator(`[data-testid="stop-card"][data-symbol="${APPLY}"]`)).not.toHaveClass(/\bon\b/);
  await expect(view.locator(`[data-testid="diff-excerpt"][data-symbol="${PLACE}"]`)).toHaveClass(/\bfocus\b/);
  await expect(page.getByTestId('selection-card').locator('li.focus .sym')).toHaveText('OrdersService.place');
});
