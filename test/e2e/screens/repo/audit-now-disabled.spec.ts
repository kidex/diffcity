// e2e/repo/audit-now-disabled (SPEC.md section 6): "Audit now" is visible
// and disabled until phase 5; hover or keyboard focus shows why.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

test('visible, disabled, with the tooltip on hover', async ({ page }) => {
  const audit = page.getByRole('button', { name: 'Audit now' });
  await expect(audit).toBeVisible();
  await expect(audit).toBeDisabled();
  await expect(audit).toHaveAccessibleDescription('Audit arrives in a later version');
  const tip = page.getByRole('tooltip');
  await expect(tip).toHaveCSS('opacity', '0');
  await audit.hover();
  await expect(tip).toHaveText('Audit arrives in a later version');
  await expect(tip).toHaveCSS('opacity', '1');
});

test('the keyboard reaches it and sees the tooltip; activating it does nothing', async ({ page }) => {
  await page.getByTestId('archive-toggle').focus();
  await page.keyboard.press('Tab');
  const audit = page.getByRole('button', { name: 'Audit now' });
  await expect(audit).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveCSS('opacity', '1');
  const url = page.url();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(page.url()).toBe(url);
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});
