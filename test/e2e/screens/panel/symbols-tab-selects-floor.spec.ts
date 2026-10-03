// e2e/panel/symbols-tab-selects-floor: the Symbols tab lists every touched
// symbol by file; a click on one selects its floor in the city (the building
// is selected and the floor is focused), marks the row, and the HUD selection
// card marks the same floor. The tab stays: the file view opens from a file's
// header, not from a symbol row.

import { test } from '@playwright/test';
import { SERVICE } from '../../support/hud.js';
import { selected, selectedFloor, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { APPLY, openPanel, panel, panelReport, PLACE, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/symbols-tab-selects-floor', async ({ page }) => {
  const report = panelReport();
  await openPanel(page, report);
  await tab(page, 'symbols').click();
  const group = page.getByTestId('symbol-group').filter({ hasText: SERVICE });
  // Touched symbols only: validate, place, calcTotal, applyDiscount, notify; the constructor and the class are untouched.
  const rows = group.getByTestId('symbol-row');
  const service = report.packages.flatMap((pkg) => pkg.files).find((file) => file.id === SERVICE);
  await expect(rows).toHaveCount(service?.symbols.filter((symbol) => symbol.status !== 'same').length ?? -1);
  await expect(group.getByRole('button', { name: /OrdersService\.constructor/ })).toHaveCount(0);

  const apply = group.locator(`[data-testid="symbol-row"][data-symbol="${APPLY}"]`);
  await expect(apply).toContainText('OrdersService.applyDiscount');
  await expect(apply).toContainText('added');
  await apply.click();
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  expect(await selected(page)).toBe(SERVICE);
  expect(await selectedFloor(page)).toBe(APPLY);
  await expect(page.getByTestId('city')).toHaveAttribute('data-selected-floor', APPLY);
  await expect(apply).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('selection-card').locator('li.focus .sym')).toHaveText('OrdersService.applyDiscount');
  // Still in the tabs.
  await expect(page.getByTestId('file-view')).toBeHidden();
  await expect(panel(page).getByTestId('tab-symbols-body')).toBeVisible();

  // Another symbol of the same file moves the floor, not the building.
  const place = group.locator(`[data-testid="symbol-row"][data-symbol="${PLACE}"]`);
  await place.click();
  await expect.poll(() => selectedFloor(page)).toBe(PLACE);
  expect(await selected(page)).toBe(SERVICE);
  await expect(apply).not.toHaveClass(/\bon\b/);
  await expect(place).toHaveClass(/\bon\b/);
});
