// e2e/change/no-webgl-fallback-list: without WebGL the change screen says the
// 3D view needs it and lists the touched files of the Report with status and
// verdict, as the daemon computed them.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { withoutWebgl } from '../../support/scene.js';

test('change/no-webgl-fallback-list', async ({ page }) => {
  await withoutWebgl(page);
  await mockApi(page);
  await page.goto('/#/change/11');

  await expect(page.getByTestId('no-webgl-note')).toHaveText('3D view needs WebGL');
  await expect(page.getByTestId('city')).toHaveCount(0);
  const files = page.getByTestId('touched-file');
  await expect(files).toHaveCount(6);
  await expect(files.locator('.file-path')).toHaveText([
    'src/orders/discounts.ts',
    'src/orders/orders.service.ts',
    'src/orders/orders.controller.ts',
    'src/payments/charge.ts',
    'src/cart/legacy-coupon.ts',
    'migrations/0042_order_discounts.sql',
  ]);
  const charge = files.filter({ hasText: 'src/payments/charge.ts' });
  await expect(charge.getByTestId('file-status')).toHaveText('signature');
  await expect(charge.getByTestId('file-verdict')).toHaveText('Needs your eyes');
  await expect(charge.getByText('tier 1')).toBeVisible();
  await expect(files.filter({ hasText: 'legacy-coupon' }).getByTestId('file-status')).toHaveText('removed');
  await expect(page.getByText('src/cart/cart.ts')).toHaveCount(0);
});
