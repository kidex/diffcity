// e2e/a11y/filters-aria-pressed (DC-89): every filter chip and every tab of the
// panel is a toggle button with aria-pressed that follows the filter; the
// chip that clears the filters is never pressed.

import { test } from '@playwright/test';
import { openReview } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('a11y/filters-aria-pressed', async ({ page }) => {
  await openReview(page);
  const chips = page.locator('.hud .chips button');
  const count = await chips.count();
  // Verdicts, change types, Show everything and Hide checked (the screen has review marks).
  expect(count).toBeGreaterThanOrEqual(10);
  for (let i = 0; i < count; i += 1) await expect(chips.nth(i)).toHaveAttribute('aria-pressed', /^(true|false)$/);
  await expect(page.locator('.hud .chips button[aria-pressed="true"]')).toHaveCount(0);

  const eyes = page.getByTestId('filter-verdict-eyes');
  await eyes.click();
  await expect(eyes).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.hud .chips.verdicts button[aria-pressed="true"]')).toHaveCount(1);
  // Another verdict replaces it: one value per row.
  const ok = page.getByTestId('filter-verdict-ok');
  await ok.click();
  await expect(ok).toHaveAttribute('aria-pressed', 'true');
  await expect(eyes).toHaveAttribute('aria-pressed', 'false');
  const added = page.getByTestId('filter-type-add');
  await added.click();
  await expect(added).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('filter-hide-checked').click();
  await expect(page.getByTestId('filter-hide-checked')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('filter-clear')).toHaveAttribute('aria-pressed', 'false');

  // Clicking the pressed chip again turns it off; Show everything turns the rest off.
  await ok.click();
  await expect(ok).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('filter-clear').click();
  await expect(page.locator('.hud .chips button[aria-pressed="true"]')).toHaveCount(0);

  // The panel's tabs: exactly one is pressed, and it follows the click.
  const tabs = page.getByTestId('panel-tabs').getByRole('button');
  await expect(tabs).toHaveCount(4);
  await expect(page.getByTestId('tab-order')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tab-findings').click();
  await expect(page.getByTestId('tab-findings')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tab-order')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('panel-tabs').locator('button[aria-pressed="true"]')).toHaveCount(1);
});
