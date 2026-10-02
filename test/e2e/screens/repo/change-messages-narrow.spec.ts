// e2e/repo/change-messages-narrow: at 700 px the change page's loading and
// error texts stay visible (the stage hides `.title p` at 980 px and below).

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

test.use({ viewport: { width: 700, height: 900 } });

test('loading is visible and announced while the change is fetched', async ({ page }) => {
  await mockApi(page);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/changes/11', async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto('/#/change/11');
  const loading = page.getByTestId('change-loading');
  await expect(loading).toBeVisible();
  await expect(loading).toHaveRole('status');
  release();
  await expect(page.getByTestId('change-head')).toBeVisible();
  await expect(page.getByTestId('city')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
});

test('a missing change explains itself', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/change/99');
  const message = page.getByTestId('change-missing');
  await expect(message.getByRole('heading')).toHaveText('This change is gone');
  await expect(message.getByRole('status')).toBeVisible();
});

test('an unreachable daemon explains itself', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/changes/**', (route) => route.abort());
  await page.goto('/#/change/11');
  const message = page.getByTestId('change-unreachable');
  await expect(message.getByRole('status')).toHaveText('The change appears as soon as the daemon answers.');
  await expect(message.getByRole('status')).toBeVisible();
});
