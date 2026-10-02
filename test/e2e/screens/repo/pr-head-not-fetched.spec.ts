// e2e/repo/pr-head-not-fetched (SPEC.md section 3a, Q3): diffcity never
// fetches; an open PR whose head is not local shows its title and number,
// "head not fetched locally", and no counters.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

test('headAvailable false → the message, no counters, no ahead/behind', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  const row = page.locator('[data-testid="change-row"][data-change-id="12"]');
  await expect(row.getByTestId('kind')).toHaveText('PR #7');
  await expect(row.getByTestId('change-title')).toHaveText('Refresh the session before it expires');
  await expect(row.getByTestId('head-not-fetched')).toHaveText('head not fetched locally');
  await expect(row.getByTestId('computing')).toHaveCount(0);
  await expect(row.getByTestId('touched')).toHaveCount(0);
  await expect(row.getByTestId('ahead-behind')).toHaveCount(0);
});
