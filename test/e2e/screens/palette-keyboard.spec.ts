// e2e/palette-keyboard (SPEC.md section 6): Cmd+K / Ctrl+K opens the quick
// search over /api/search; Up/Down move, Enter navigates, Esc closes.

import { expect, test, type Page } from '@playwright/test';
import type { SearchResult } from '../../../src/core/model/types.js';
import { fixtures, mockApi } from '../support/mock-api.js';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Quick search' });
const input = (page: Page) => page.getByRole('combobox', { name: 'Search repos, branches and files' });
const options = (page: Page) => page.getByRole('option');
const selected = (page: Page) => page.locator('[role="option"][aria-selected="true"]');

const ALL = fixtures.searchResults();

/** Answers like the daemon would for the queries the specs type. */
function search(query: string): SearchResult[] {
  if (query === 'docs') return [{ kind: 'repo', label: 'docs-site', detail: '/work/docs-site', repoId: 3 }];
  if (query === 'zzz') return [];
  return ALL;
}

async function openHome(page: Page) {
  const api = await mockApi(page, { search });
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  return api;
}

async function searchFor(page: Page, query: string, count: number): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await input(page).pressSequentially(query);
  await expect(options(page)).toHaveCount(count);
}

test('ControlOrMeta+K opens the palette with the input focused, and the query reaches /api/search', async ({ page }) => {
  const api = await openHome(page);
  await expect(dialog(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(dialog(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(page.getByText('Type to search repos, branches and files.')).toBeVisible();

  await input(page).pressSequentially('order');
  await expect(options(page)).toHaveCount(4);
  const searched = api.requests.filter((url) => url.pathname === '/api/search').at(-1);
  expect(searched?.searchParams.get('q')).toBe('order');
  expect(searched?.searchParams.get('limit')).toBe('20');
  await expect(options(page).nth(0)).toContainText('sample-shop');
  await expect(options(page).nth(3)).toContainText('src/orders/discounts.ts');
});

test('both Cmd+K and Ctrl+K toggle it', async ({ page }) => {
  await openHome(page);
  await page.keyboard.press('Meta+k');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(dialog(page)).toBeHidden();
  await page.keyboard.press('Control+k');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(dialog(page)).toBeHidden();
});

test('Up and Down move the selection and wrap around', async ({ page }) => {
  await openHome(page);
  await searchFor(page, 'order', 4);

  await expect(selected(page)).toContainText('sample-shop');
  await expect(input(page)).toHaveAttribute('aria-activedescendant', 'palette-option-0');
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toContainText('feature/order-discounts');
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toContainText('PR #7');
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toContainText('feature/order-discounts');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toContainText('src/orders/discounts.ts');
  await expect(input(page)).toHaveAttribute('aria-activedescendant', 'palette-option-3');
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toContainText('sample-shop');
  await expect(selected(page)).toHaveCount(1);
});

test('Enter opens the selected result and closes the palette', async ({ page }) => {
  await openHome(page);
  await searchFor(page, 'order', 4);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/change\/11$/);
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('feature/order-discounts');

  // Reopened, it keeps the last query; Enter on the first result opens the repo.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(options(page)).toHaveCount(4);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/repo\/1$/);
});

test('a file result opens the change that touched it', async ({ page }) => {
  await openHome(page);
  await searchFor(page, 'order', 4);
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toContainText('src/orders/discounts.ts');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/change\/11$/);
});

test('Enter right after typing opens a result for what was typed, not a stale one', async ({ page }) => {
  await openHome(page);
  await searchFor(page, 'order', 4);
  await input(page).fill('docs');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/repo\/3$/);
});

test('a click on a result opens it', async ({ page }) => {
  await openHome(page);
  await searchFor(page, 'order', 4);
  await options(page).filter({ hasText: 'PR #7' }).click();
  await expect(page).toHaveURL(/#\/change\/12$/);
  await expect(dialog(page)).toBeHidden();
});

test('Esc closes the palette and gives focus back', async ({ page }) => {
  await openHome(page);
  const trigger = page.getByRole('button', { name: /Search/ });
  await trigger.click();
  await expect(dialog(page)).toBeVisible();
  await input(page).pressSequentially('order');
  await expect(options(page)).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/#\/$/);
});

test('Tab and Shift+Tab keep focus inside the modal palette, and aria-expanded follows the list', async ({ page }) => {
  await openHome(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(input(page)).toHaveAttribute('aria-expanded', 'false');
  await input(page).pressSequentially('order');
  await expect(options(page)).toHaveCount(4);
  await expect(input(page)).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Shift+Tab');
  await expect(input(page)).toBeFocused();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(input(page)).toBeFocused();
  await input(page).fill('zzz');
  await expect(page.getByText('No matches.')).toBeVisible();
  await expect(input(page)).toHaveAttribute('aria-expanded', 'false');
});

test('no matches says so, and Enter does nothing', async ({ page }) => {
  await openHome(page);
  await page.keyboard.press('ControlOrMeta+k');
  await input(page).pressSequentially('zzz');
  await expect(page.getByText('No matches.')).toBeVisible();
  await expect(options(page)).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
});
