// e2e/shell-breadcrumb (SPEC.md section 6): the fleet / repo / change
// breadcrumb follows the route and navigates back up.

import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../support/mock-api.js';

const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('listitem');
const current = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' }).locator('[aria-current="page"]');

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('Fleet is the only crumb on the home screen', async ({ page }) => {
  await page.goto('/#/');
  await expect(crumbs(page)).toHaveText(['Fleet']);
  await expect(current(page)).toHaveText('Fleet');
  await expect(page.locator('[data-screen="fleet"]')).toBeVisible();
});

test('Repo shows Fleet / repo name', async ({ page }) => {
  await page.goto('/#/repo/1');
  await expect(crumbs(page)).toHaveText(['Fleet', 'sample-shop']);
  await expect(current(page)).toHaveText('sample-shop');
  await expect(page.getByRole('link', { name: 'Fleet', exact: true })).toHaveAttribute('href', '#/');
  await expect(page.locator('[data-screen="repo"]')).toBeVisible();
});

test('Change shows Fleet / repo / branch against base, and each crumb goes back up', async ({ page }) => {
  await page.goto('/#/change/11');
  await expect(crumbs(page)).toHaveText(['Fleet', 'sample-shop', /^feature\/order-discounts\s*against\s*main\s*2 commits, /]);
  await expect(page.locator('[data-screen="change"]')).toContainText('Change view arrives in phase 3');

  await page.getByRole('link', { name: 'sample-shop' }).click();
  await expect(page).toHaveURL(/#\/repo\/1$/);
  await expect(crumbs(page)).toHaveText(['Fleet', 'sample-shop']);

  await page.getByRole('link', { name: 'Fleet', exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(crumbs(page)).toHaveText(['Fleet']);
});

test('a pull request reads PR #N against its base', async ({ page }) => {
  await page.goto('/#/change/12');
  await expect(crumbs(page)).toHaveText(['Fleet', 'sample-shop', /^PR #7\s*against\s*main/]);
  await expect(current(page).locator('.branch').first()).toHaveAttribute('title', 'Refresh the session before it expires');
});

test('the brand goes to Fleet', async ({ page }) => {
  await page.goto('/#/repo/1');
  await expect(current(page)).toHaveText('sample-shop');
  await page.getByRole('link', { name: 'diffcity, all repos' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(crumbs(page)).toHaveText(['Fleet']);
});

test('an unknown route shows Fleet and becomes #/', async ({ page }) => {
  await page.goto('/#/settings/profile');
  await expect(page).toHaveURL(/#\/$/);
  await expect(crumbs(page)).toHaveText(['Fleet']);
});

test('back and forward follow the history', async ({ page }) => {
  await page.goto('/#/');
  await page.evaluate("location.hash = '#/repo/1'");
  await expect(current(page)).toHaveText('sample-shop');
  await page.goBack();
  await expect(crumbs(page)).toHaveText(['Fleet']);
  await page.goForward();
  await expect(current(page)).toHaveText('sample-shop');
});
