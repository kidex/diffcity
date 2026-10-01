// e2e/fleet/keyboard (ADR-022): the lots are focusable links with an
// accessible name that says what the row says; Enter opens the repo.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

test('lots are links with descriptive names', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  const map = page.getByRole('group', { name: 'Repo map' });
  await expect(map.getByRole('link')).toHaveCount(3);
  await expect(map.getByRole('link', { name: /^sample-shop, 3 unreviewed changes, 1 draft, 2 branch, 1 PR, 0 high findings, last audit never audited$/ })).toBeVisible();
  await expect(map.getByRole('link', { name: /^order-service, 1 unreviewed change, .*collecting$/ })).toBeVisible();
  await expect(map.getByRole('link', { name: /^docs-site, .*inactive$/ })).toBeVisible();
});

test('Tab reaches the lots in list order and Enter opens a repo', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  await expect(page.getByTestId('lot')).toHaveCount(3);
  await page.getByTestId('lot').first().focus();
  await expect(page.locator('[data-testid="lot"][data-repo-id="1"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-testid="lot"][data-repo-id="2"]')).toBeFocused();
  // The focused lot is highlighted, with its row.
  await expect(page.locator('[data-testid="lot"][data-repo-id="2"]')).toHaveClass(/hot/);
  await expect(page.getByTestId('repo-row').filter({ hasText: 'order-service' })).toHaveClass(/hot/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/repo\/2$/);
});

test('Tab from the top bar reaches the first lot', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  await expect(page.getByTestId('lot')).toHaveCount(3);
  await page.getByRole('button', { name: /Search/ }).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-testid="lot"][data-repo-id="1"]')).toBeFocused();
});
