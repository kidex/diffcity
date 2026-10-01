// e2e/repo/empty-and-missing: a repo with no change says what will appear;
// an unknown repo id says it is not tracked and links back to Fleet.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

test('a repo with no change says so', async ({ page }) => {
  const empty = fixtures.repoEmpty();
  await mockApi(page, { details: [fixtures.repoMixedChanges(), empty] });
  await page.goto('/#/repo/3');
  await expect(page.locator('.repo-head h1')).toHaveText('docs-site');
  await expect(page.getByTestId('change-row')).toHaveCount(0);
  await expect(page.getByTestId('list-empty')).toContainText('No changes yet.');
  await expect(page.getByRole('button', { name: 'Audit now' })).toBeVisible();
});

test('an unknown repo is not tracked', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/99');
  await expect(page.getByTestId('repo-missing')).toContainText('This repo is not tracked');
  await page.getByRole('link', { name: 'Back to all repos' }).click();
  await expect(page).toHaveURL(/#\/$/);
});
