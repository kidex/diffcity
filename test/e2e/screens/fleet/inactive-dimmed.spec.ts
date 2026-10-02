// e2e/fleet/inactive-dimmed (Q6, ADR-022): an inactive repo's lot is drawn
// at opacity 0.5, and its row is dimmed too; active ones are not.

import { expect, test } from '@playwright/test';
import { computed } from '../../support/css.js';
import { mockApi } from '../../support/mock-api.js';

test('an inactive repo is dimmed on the map and in the list', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  const inactive = page.locator('[data-testid="lot"][data-repo-id="3"]');
  const active = page.locator('[data-testid="lot"][data-repo-id="1"]');
  await expect(inactive).toHaveClass(/inactive/);
  await expect(inactive).toHaveCSS('opacity', '0.5');
  await expect(active).toHaveCSS('opacity', '1');

  const row = page.getByTestId('repo-row').filter({ hasText: 'docs-site' });
  await expect(row.getByTestId('inactive')).toHaveText('inactive');
  expect(Number(await computed(row, 'opacity'))).toBeLessThan(1);
  await expect(page.getByTestId('repo-row').filter({ hasText: 'sample-shop' })).toHaveCSS('opacity', '1');
});
