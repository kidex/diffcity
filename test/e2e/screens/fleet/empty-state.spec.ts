// e2e/fleet/empty-state (SPEC.md section 3, ADR-022): with no repos the
// Fleet screen shows the one command to run, `diffcity start`.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

test('no repos → the diffcity start instruction', async ({ page }) => {
  await mockApi(page, { repos: fixtures.fleetEmpty() });
  await page.goto('/#/');
  const empty = page.getByTestId('fleet-empty');
  await expect(empty).toBeVisible();
  await expect(empty.getByRole('heading', { name: 'No repos yet' })).toBeVisible();
  await expect(empty.locator('code')).toHaveText('diffcity start');
  await expect(page.locator('[data-screen="fleet"]')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('lot')).toHaveCount(0);
  await expect(page.getByTestId('fleet-list')).toHaveCount(0);
});

test('the copy button puts the command on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApi(page, { repos: fixtures.fleetEmpty() });
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Copy the command' }).click();
  await expect(page.getByRole('button', { name: 'Copy the command' })).toHaveText('Copied');
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe('diffcity start');
});

test('a daemon that does not answer → the unreachable state, not the empty one', async ({ page }) => {
  await page.route('**/api/repos', (route) => route.fulfill({ status: 503, json: { error: { code: 'down', message: 'down' } } }));
  await page.goto('/#/');
  await expect(page.getByTestId('fleet-unreachable')).toBeVisible();
  await expect(page.getByTestId('fleet-unreachable').locator('code')).toHaveText('diffcity start');
  await expect(page.getByTestId('fleet-empty')).toHaveCount(0);
});
