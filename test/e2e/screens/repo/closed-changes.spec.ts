// e2e/repo/closed-changes (SPEC.md section 3a, DC-57): the archive toggle says
// what it does and why the changes are there; showing the closed changes
// swaps the open list's filters for the closed list's own bar, not just a
// reset of the same chips.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

const HINT = 'Merged, deleted, closed or cleaned changes, kept for 90 days';

test('the toggle explains itself on hover and on keyboard focus', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  const toggle = page.getByTestId('archive-toggle');
  const tip = page.getByRole('tooltip', { name: HINT });

  await toggle.hover();
  await expect(tip).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await toggle.focus();
  await expect(tip).toHaveCSS('opacity', '1');
});

test('the closed list replaces the open filters and says what it holds', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.getByTestId('open-filters')).toBeVisible();
  await expect(page.getByTestId('closed-filters')).toHaveCount(0);

  await page.getByTestId('archive-toggle').click();
  await expect(page.getByTestId('change-row')).toHaveCount(4);
  await expect(page.getByTestId('open-filters')).toHaveCount(0);
  await expect(page.getByTestId('closed-filters')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Filter by review state' })).toHaveCount(0);
  await expect(page.locator('.repo .changes header p')).toHaveText(`${HINT}.`);

  // The closed list's own kind filter works, and its own reset clears it.
  const kinds = page.getByRole('group', { name: 'Filter by kind' });
  await kinds.getByRole('button', { name: /^Branch/ }).click();
  await expect(page.getByTestId('change-row')).toHaveCount(2);
  await expect(page.getByTestId('change-count')).toHaveText('2 of 4');
  await page.getByTestId('show-all-closed').click();
  await expect(page.getByTestId('change-row')).toHaveCount(4);

  await page.getByTestId('archive-toggle').click();
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.getByTestId('open-filters')).toBeVisible();
  await expect(page.getByTestId('closed-filters')).toHaveCount(0);
  await expect(page.locator('.repo .changes header p')).toHaveText('Drafts, branches and pull requests, latest activity first.');
});
