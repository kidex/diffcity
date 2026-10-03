// e2e/change/hover-select-escape: the city container carries the hovered and
// selected building as data attributes (data-hovered, data-selected), so the
// pointer and keyboard flow is checked through state, not pixels: the
// ?scene-debug hook (hovered(), selected()), the data attributes and the roof
// label's is-hover / is-selected classes, which follow the same focus as the
// brightened outline (CityView.setHover). Hover marks a building, a click
// selects it, hovering another building keeps the
// selection, a drag is not a click, a click on empty ground clears, and
// Escape clears too.

import { test, type Locator, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { hovered, openCity, project, selected, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';

// A first frame on SwiftShader, plus what each spec does after it, can pass the default 30 s.
test.describe.configure({ timeout: 60_000 });

const GUARD = 'src/auth/order.guard.ts';
const MIGRATION = 'db/migrations/20260921_order_discounts.sql';

const label = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="roof-label"][data-building="${id}"]`);

test('change/hover-select-escape', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);
  const city = page.getByTestId('city');
  const canvas = page.getByTestId('city-canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  const empty = { x: box.x + 30, y: box.y + box.height - 30 };

  // Nothing hovered at an empty corner (the attribute appears with the first hover).
  await page.mouse.move(empty.x, empty.y);
  await expect.poll(async () => (await city.getAttribute('data-hovered')) ?? '').toBe('');

  // Hover the tier 1 guard.
  const guard = await project(page, GUARD);
  await page.mouse.move(guard.x, guard.y, { steps: 3 });
  await waitForCityAttribute(page, 'data-hovered', GUARD);
  await expect.poll(() => hovered(page)).toBe(GUARD);
  await expect(label(page, GUARD)).toHaveClass(/is-hover/);
  await expect(canvas).toHaveCSS('cursor', 'pointer');

  // Click selects it.
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  expect(await selected(page)).toBe(GUARD);
  await expect(label(page, GUARD)).toHaveClass(/is-selected/);

  // Hovering another building moves the hover, the selection stays.
  const migration = await project(page, MIGRATION);
  await page.mouse.move(migration.x, migration.y, { steps: 3 });
  await waitForCityAttribute(page, 'data-hovered', MIGRATION);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  expect(await hovered(page)).toBe(MIGRATION);
  expect(await selected(page)).toBe(GUARD);
  await expect(label(page, MIGRATION)).toHaveClass(/is-hover/);
  await expect(label(page, GUARD)).not.toHaveClass(/is-hover/);

  // Escape clears the selection; the hover stays under the pointer.
  await page.keyboard.press('Escape');
  await waitForCityAttribute(page, 'data-selected', '');
  await waitForCityAttribute(page, 'data-hovered', MIGRATION);
  expect(await selected(page)).toBeNull();
  await expect(page.locator('[data-testid="roof-label"].is-selected')).toHaveCount(0);

  // A drag that starts on a building orbits and does not select it.
  await page.mouse.down();
  await page.mouse.move(migration.x + 40, migration.y + 5, { steps: 4 });
  await page.mouse.up();
  await waitForCityAttribute(page, 'data-selected', '');

  // Select again, then a click on empty ground clears.
  const again = await project(page, MIGRATION);
  await page.mouse.click(again.x, again.y);
  await waitForCityAttribute(page, 'data-selected', MIGRATION);
  await page.mouse.click(empty.x, empty.y);
  await waitForCityAttribute(page, 'data-selected', '');

  // Leaving the canvas clears the hover and the pointer cursor.
  await page.mouse.move(box.x + box.width / 2, box.y - 20);
  await waitForCityAttribute(page, 'data-hovered', '');
  expect(await hovered(page)).toBeNull();
  await expect(page.locator('[data-testid="roof-label"].is-hover')).toHaveCount(0);
  await expect(canvas).not.toHaveCSS('cursor', 'pointer');
});
