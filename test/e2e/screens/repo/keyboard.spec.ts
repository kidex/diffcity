// e2e/repo/keyboard (ADR-022): the Repo screen works with the keyboard only:
// Tab reaches the archive toggle, "Audit now", the filter chips and the row
// links in order; Enter or Space toggles a chip; Enter on a row opens the
// change; a click anywhere on a row does the same.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

test('Tab order: archive, audit, kind chips, review chips, Show everything, rows', async ({ page }) => {
  await page.getByRole('button', { name: /Search/ }).focus();
  const expected = [
    page.getByTestId('archive-toggle'),
    page.getByRole('button', { name: 'Audit now' }),
    page.getByRole('button', { name: /^Draft/ }),
    page.getByRole('button', { name: /^Branch/ }),
    page.getByRole('button', { name: /^PR/ }),
    page.getByRole('button', { name: /^Unreviewed/ }),
    page.getByRole('button', { name: /^In review/ }),
    page.getByRole('button', { name: /^Approved/ }),
    page.getByTestId('show-everything'),
    page.getByRole('link', { name: 'Add percentage discounts to orders' }),
    page.getByRole('link', { name: 'Uncommitted changes on main' }),
  ];
  for (const target of expected) {
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
  }
});

test('Space and Enter toggle a chip; Enter on a row opens the change', async ({ page }) => {
  const pr = page.getByRole('button', { name: /^PR/ });
  await pr.focus();
  await page.keyboard.press('Space');
  await expect(pr).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('change-row')).toHaveCount(2);
  await page.keyboard.press('Enter');
  await expect(pr).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('change-row')).toHaveCount(6);

  await page.getByRole('link', { name: 'Add percentage discounts to orders' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/change\/11$/);
  await expect(page.getByTestId('change-head')).toBeVisible();
});

test('a click anywhere on a row opens its change', async ({ page }) => {
  await page.locator('[data-testid="change-row"][data-change-id="13"] .where').click();
  await expect(page).toHaveURL(/#\/change\/13$/);
});
