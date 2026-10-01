// e2e/repo/change-placeholder: until phase 3, `#/change/:id` shows the change
// header (kind, ref, title), the touched files of its Report with status and
// verdict, the way back to the repo, and the phase 3 note. A change without a
// snapshot says it is computing, and fills in on SSE `snapshot`.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

test('header, touched files with status and verdict, back link, note', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await page.getByRole('link', { name: 'Add percentage discounts to orders' }).click();
  await expect(page).toHaveURL(/#\/change\/11$/);

  const head = page.getByTestId('change-head');
  await expect(head.getByTestId('change-kind')).toHaveText('Branch');
  await expect(head.getByRole('heading', { level: 1 })).toHaveText('Add percentage discounts to orders');
  await expect(head.getByTestId('change-ref')).toHaveText('feature/order-discounts');
  await expect(page.getByTestId('phase-note')).toContainText('Change view arrives in phase 3');

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
  // Untouched files are not listed.
  await expect(page.getByText('src/cart/cart.ts')).toHaveCount(0);
  await expect(page.getByTestId('report-meta')).toContainText('head 3f2a9c4');

  await page.getByTestId('back-to-repo').click();
  await expect(page).toHaveURL(/#\/repo\/1$/);
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

test('a PR shows PR #N and no ref line', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/change/12');
  await expect(page.getByTestId('change-kind')).toHaveText('PR #7');
  await expect(page.getByTestId('change-ref')).toHaveCount(0);
  await expect(page.getByTestId('report-computing')).toBeVisible();
});

test('a change without a snapshot fills in on SSE snapshot', async ({ page }, testInfo) => {
  const reports = {};
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/change/11');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('report-computing')).toHaveText('Computing the first snapshot of this change…');

  Object.assign(reports, { 11: fixtures.reportOrderDiscounts() });
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });
  await expect(page.getByTestId('touched-file')).toHaveCount(6);
});

test('an archived change opens from the archive', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await page.getByTestId('archive-toggle').click();
  await page.getByRole('link', { name: 'Sell gift cards at checkout' }).click();
  await expect(page).toHaveURL(/#\/change\/21$/);
  await expect(page.getByTestId('change-head')).toContainText('Merged');
});
