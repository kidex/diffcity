// e2e/change/selection-card (the direction C prototype's card): selecting a
// building shows its verdict, tier, file, counts and symbols with their
// status at the bottom right; Escape or a click on empty ground hides it.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { GUARD, MIGRATION } from '../../support/hud.js';
import { openCity, project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/selection-card', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);
  const card = page.getByTestId('selection-card');
  await expect(card).toBeHidden();

  const guard = await project(page, GUARD);
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('card-verdict')).toHaveText('Needs your eyes');
  await expect(card.getByTestId('card-tier')).toHaveText('tier 1');
  await expect(card.getByTestId('card-file')).toHaveText(GUARD);
  await expect(card.getByTestId('card-counts')).toHaveText('+0 added0 modified1 sig0 removed');
  const symbols = card.getByRole('list', { name: 'Symbols' }).getByRole('listitem');
  // Top floor first.
  await expect(symbols).toHaveText(['OrderGuard.canPlacesignature', 'OrderGuard.canRead', 'OrderGuard']);
  await expect(symbols.first()).toHaveAttribute('data-status', 'sig');
  // At the bottom right of the city.
  const city = await page.getByTestId('city').boundingBox();
  const box = await card.boundingBox();
  if (city === null || box === null) throw new Error('no boxes');
  expect(box.x + box.width).toBeGreaterThan(city.x + city.width - 40);
  expect(box.y + box.height).toBeGreaterThan(city.y + city.height - 60);

  // Another building replaces it; a migration is tier 1 too and its floors are added.
  const migration = await project(page, MIGRATION);
  await page.mouse.click(migration.x, migration.y);
  await waitForCityAttribute(page, 'data-selected', MIGRATION);
  await expect(card.getByTestId('card-file')).toHaveText(MIGRATION);
  await expect(card.getByTestId('card-counts')).toHaveText('+2 added0 modified0 sig0 removed');

  await page.keyboard.press('Escape');
  await waitForCityAttribute(page, 'data-selected', '');
  await expect(card).toBeHidden();
});
