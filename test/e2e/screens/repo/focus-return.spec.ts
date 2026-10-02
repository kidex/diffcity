// e2e/repo/focus-return: back from a change (the back link or browser Back),
// focus lands on the row the change was opened from, scrolled into view,
// not on <body>.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

test('the back link returns focus to the opened row', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  const link = page.getByRole('link', { name: 'Round cart totals once' });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/change\/13$/);
  await page.getByTestId('back-to-repo').click();
  await expect(page).toHaveURL(/#\/repo\/1$/);
  await expect(page.getByRole('link', { name: 'Round cart totals once' })).toBeFocused();
});

test('browser Back returns focus to a deep row of a long list, in view', async ({ page }) => {
  const detail = fixtures.repoLongList();
  await mockApi(page, { details: [detail] });
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(44);
  const last = detail.changes.at(-1);
  if (!last) throw new Error('repo-long-list.json is empty');
  const row = page.locator(`[data-testid="change-row"][data-change-id="${String(last.id)}"]`);
  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`#/change/${String(last.id)}$`));
  await page.goBack();
  await expect(row.getByRole('link')).toBeFocused();
  await expect(row).toBeInViewport();
});

test('a later visit without opening a change does not steal focus', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await page.getByRole('link', { name: 'Round cart totals once' }).click();
  await page.getByTestId('back-to-repo').click();
  await expect(page.getByRole('link', { name: 'Round cart totals once' })).toBeFocused();
  await page.getByRole('link', { name: 'Fleet', exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/#\/repo\/1$/);
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.getByRole('link', { name: 'Round cart totals once' })).not.toBeFocused();
});
