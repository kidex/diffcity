// e2e/repo/computing-state (ADR-017, Q8): a change without a snapshot yet
// (`stats` null) reads "computing" instead of counters.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

test('stats null → computing, no counters', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  const row = page.locator('[data-testid="change-row"][data-change-id="13"]');
  await expect(row.getByTestId('computing')).toHaveText('computing');
  await expect(row.getByTestId('touched')).toHaveCount(0);
  await expect(row.getByTestId('verdicts')).toHaveCount(0);
  // Only that change is computing: the PR without its head is not.
  await expect(page.getByTestId('computing')).toHaveCount(1);
});
