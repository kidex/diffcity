// e2e/fleet/click-enters-repo (SPEC.md section 6): a click on a lot or on a
// list row opens the Repo screen of that repo.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

test('a click on a lot opens its repo', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  await page.locator('[data-testid="lot"][data-repo-id="1"]').click();
  await expect(page).toHaveURL(/#\/repo\/1$/);
  await expect(page.locator('[data-screen="repo"]')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('sample-shop');
});

test('a click anywhere on a row opens its repo', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  const row = page.getByTestId('repo-row').filter({ hasText: 'order-service' });
  await row.locator('[data-col="unreviewed"]').click();
  await expect(page).toHaveURL(/#\/repo\/2$/);
});

test('the repo name in a row is a link to the repo', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  await expect(page.getByRole('link', { name: 'docs-site', exact: true })).toHaveAttribute('href', '#/repo/3');
});

test('hovering a row highlights its lot, and hovering a lot its row', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  await page.getByTestId('repo-row').filter({ hasText: 'order-service' }).hover();
  await expect(page.locator('[data-testid="lot"][data-repo-id="2"]')).toHaveClass(/hot/);
  await page.locator('[data-testid="lot"][data-repo-id="1"]').hover();
  await expect(page.getByTestId('repo-row').filter({ hasText: 'sample-shop' })).toHaveClass(/hot/);
  await expect(page.locator('.fleet-map .tip')).toHaveClass(/show/);
  await expect(page.locator('.fleet-map .tip')).toContainText('/work/sample-shop');
});
