// e2e/repo/filter-review-state (SPEC.md section 6): the review-state chips
// filter the list and combine with the kind chips (AND); "Show everything"
// clears both rows, as in the mockup.

import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { shownChangeIds as shownIds } from '../../support/repo.js';

const kinds = (page: Page) => page.getByRole('group', { name: 'Filter by kind' });
const reviews = (page: Page) => page.getByRole('group', { name: 'Filter by review state' });

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

test('the chips show a counter per review state, then Show everything', async ({ page }) => {
  await expect(reviews(page).getByRole('button')).toHaveText(['Unreviewed 4', 'In review 1', 'Approved 1', 'Show everything']);
});

test('a review-state chip filters and toggles off', async ({ page }) => {
  const unreviewed = reviews(page).getByRole('button', { name: /^Unreviewed/ });
  await unreviewed.click();
  await expect(page.getByTestId('change-row')).toHaveCount(4);
  expect(await shownIds(page)).toEqual(['11', '10', '12', '13']);
  await unreviewed.click();
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

test('kind AND review state, and Show everything resets both', async ({ page }) => {
  await kinds(page).getByRole('button', { name: /^PR/ }).click();
  await reviews(page).getByRole('button', { name: /^Unreviewed/ }).click();
  await expect(page.getByTestId('change-row')).toHaveCount(1);
  expect(await shownIds(page)).toEqual(['12']);

  await reviews(page).getByRole('button', { name: /^Approved/ }).click();
  expect(await shownIds(page)).toEqual(['15']);

  await page.getByTestId('show-everything').click();
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  for (const chip of await page.locator('.repo .filters [aria-pressed]').all()) await expect(chip).toHaveAttribute('aria-pressed', 'false');
});

test('no match says so', async ({ page }) => {
  await kinds(page).getByRole('button', { name: /^Draft/ }).click();
  await reviews(page).getByRole('button', { name: /^Approved/ }).click();
  await expect(page.getByTestId('change-row')).toHaveCount(0);
  await expect(page.getByTestId('list-empty')).toHaveText('No change matches these filters.');
  await page.getByTestId('show-everything').click();
  await expect(page.getByTestId('list-empty')).toBeHidden();
});
