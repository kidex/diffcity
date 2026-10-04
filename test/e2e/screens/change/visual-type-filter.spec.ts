// e2e/change/visual-type-filter (SPEC.md section 6, Q1): the Signature changed
// filter dims every building without a signature change, and the chip reads as
// on. Linux CI baseline.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { sceneExpect } from '../../support/scene.js';
import { linuxOnly, openVisualCity, prepareVisual, settle, shot } from '../../support/visual.js';

linuxOnly();
test.describe.configure({ timeout: 120_000 });

test('change/visual-type-filter', async ({ page }) => {
  await prepareVisual(page);
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openVisualCity(page);
  await page.getByTestId('filter-type-sig').click();
  await sceneExpect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=sig;rule=');
  await settle(page);
  await expect(page).toHaveScreenshot('type-filter.png', shot(page));
});
