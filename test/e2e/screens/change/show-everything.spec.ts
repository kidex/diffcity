// e2e/change/show-everything (ADR-026): "Show everything" clears every filter
// row at once: verdict, type and rule.

import { test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { paintDump, ruleReport } from '../../support/hud.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/show-everything', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: ruleReport() } });
  await openCity(page);
  const city = page.getByTestId('city');

  await page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Reviewed, fine/ }).click();
  await page.getByRole('group', { name: 'Filter by change type' }).getByRole('button', { name: /^Added/ }).click();
  await page.getByRole('group', { name: 'Filter by rule' }).getByRole('button', { name: /^layers/ }).click();
  await expect(city).toHaveAttribute('data-filters', 'verdict=ok;type=add;rule=layers');
  expect((await paintDump(page)).dimmed.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Show everything' }).click();
  await expect(city).toHaveAttribute('data-filters', 'verdict=;type=;rule=');
  for (const chip of await page.locator('.hud .chip[aria-pressed]').all()) await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await paintDump(page)).dimmed).toEqual([]);
  expect(Object.keys((await paintDump(page)).floors)).toEqual([]);
});
