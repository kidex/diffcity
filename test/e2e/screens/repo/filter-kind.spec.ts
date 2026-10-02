// e2e/repo/filter-kind (SPEC.md section 6): the kind chips filter the list
// like the mockup's chips: one at a time, a click on the active one turns it
// off, the counters count the whole list.

import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { shownChangeIds as shownIds } from '../../support/repo.js';

const kinds = (page: Page) => page.getByRole('group', { name: 'Filter by kind' });

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

test('the chips show a counter per kind', async ({ page }) => {
  await expect(kinds(page).getByRole('button')).toHaveText(['Draft 1', 'Branch 3', 'PR 2']);
  for (const chip of await kinds(page).getByRole('button').all()) await expect(chip).toHaveAttribute('aria-pressed', 'false');
});

test('a kind chip filters, a second click turns it off', async ({ page }) => {
  const branch = kinds(page).getByRole('button', { name: /^Branch/ });
  await branch.click();
  await expect(branch).toHaveAttribute('aria-pressed', 'true');
  await expect(branch).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('change-row')).toHaveCount(3);
  expect(await shownIds(page)).toEqual(['11', '13', '14']);
  await expect(page.getByTestId('change-count')).toHaveText('3 of 6');
  await expect(page.getByTestId('change-count')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('change-count-text')).toHaveText('3 of 6 changes shown');
  await expect(page.getByRole('region', { name: 'Changes' })).toContainText('3 of 6 changes shown');
  // The counters do not move.
  await expect(kinds(page).getByRole('button')).toHaveText(['Draft 1', 'Branch 3', 'PR 2']);

  await branch.click();
  await expect(branch).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.getByTestId('change-count')).toHaveText('6');
  await expect(page.getByTestId('change-count-text')).toHaveText('6 changes');
});

test('another kind chip replaces the active one', async ({ page }) => {
  await kinds(page).getByRole('button', { name: /^Draft/ }).click();
  expect(await shownIds(page)).toEqual(['10']);
  await kinds(page).getByRole('button', { name: /^PR/ }).click();
  await expect(page.getByTestId('change-row')).toHaveCount(2);
  expect(await shownIds(page)).toEqual(['12', '15']);
  await expect(kinds(page).getByRole('button', { name: /^Draft/ })).toHaveAttribute('aria-pressed', 'false');
});
