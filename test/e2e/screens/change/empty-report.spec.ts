// e2e/change/empty-report: a Report without files says so instead of
// drawing an empty city.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

test('change/empty-report', async ({ page }) => {
  const empty = { ...fixtures.reportGolden(), packages: [] };
  await mockApi(page, { reports: { 11: empty } });
  await page.goto('/#/change/11');
  await expect(page.getByTestId('change-head')).toBeVisible();
  await expect(page.getByTestId('no-files')).toHaveText('No files in this change');
  await expect(page.getByTestId('city')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
});
