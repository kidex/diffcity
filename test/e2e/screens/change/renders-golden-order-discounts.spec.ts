// e2e/change/renders-golden-order-discounts (ADR-026): the golden Report of
// the order-discounts scenario renders as the night city under the change
// header, on a live WebGL2 context: a building per file, a lot per package, a
// roof label with the verdict tag above each touched building only.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { hasWebgl2, openCity, stats } from '../../support/scene.js';

test('change/renders-golden-order-discounts', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const golden = fixtures.reportGolden();
  await mockApi(page, { reports: { 11: golden } });
  await openCity(page);

  expect(await hasWebgl2(page)).toBe(true);
  await expect(page.getByTestId('change-head').getByRole('heading', { level: 1 })).toHaveText('Add percentage discounts to orders');

  const files = golden.packages.flatMap((pkg) => pkg.files);
  const touched = files.filter((file) => file.status !== 'same');
  const scene = await stats(page);
  expect(scene.buildings).toBe(files.length);
  expect(scene.lots).toBe(golden.packages.length);
  expect(scene.floors).toBe(files.reduce((sum, file) => sum + Math.max(file.symbols.length, 1), 0));
  expect(scene.labels).toBe(touched.length);

  const labels = page.getByTestId('roof-label');
  await expect(labels).toHaveCount(touched.length);
  const guard = labels.and(page.locator('[data-building="src/auth/order.guard.ts"]'));
  await expect(guard.locator('.badge')).toHaveText('Needs your eyes');
  await expect(guard.locator('.file')).toHaveText('order.guard.ts');
  await expect(labels.and(page.locator('[data-building="src/repo/orders.repo.ts"]')).locator('.badge')).toHaveText('Reviewed, fine');
  // Untouched files are buildings without a label.
  await expect(page.locator('[data-building="src/shared/money.ts"]')).toHaveCount(0);

  const path = testInfo.outputPath('change-golden.png');
  await page.screenshot({ path });
  await testInfo.attach('change-golden', { path, contentType: 'image/png' });
});
