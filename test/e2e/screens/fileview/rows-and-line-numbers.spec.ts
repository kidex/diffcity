// e2e/fileview/rows-and-line-numbers (SPEC.md section 6, ADR-027): the full
// diff has an old and a new line number on each row, a + or − gutter, the
// --code-add / --code-del backgrounds on added and removed rows, and a mark on
// a row the daemon cut. The view opens at the first hunk.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { diffRows, diffView, openDiff, scrollOf, scrollHeightOf, serveGuard, setScroll } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

/** The computed background colour of an element that has `var(token)` as its background. */
const tokenBackground = (token: string): string =>
  `(() => { const probe = document.createElement('div'); probe.style.background = 'var(${token})'; document.body.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color; })()`;

test('fileview/rows-and-line-numbers', async ({ page }) => {
  await openDiff(page, serveGuard());
  const view = diffView(page);
  await expect(view).toHaveAttribute('data-state', 'text');
  await expect(view).toHaveAttribute('data-rows', '61');

  // Opens at the first hunk: its rows are in the viewport, near the top.
  const removed = diffRows(page).and(page.locator('[data-row="22"]'));
  await expect(removed).toBeVisible();
  expect(await scrollOf(page)).toBeGreaterThan(0);

  // A removed row: old number only, the − gutter, the --code-del background.
  await expect(removed).toHaveAttribute('data-kind', 'del');
  await expect(removed.getByTestId('diff-old')).toHaveText('23');
  await expect(removed.getByTestId('diff-new')).toHaveText('');
  await expect(removed.getByTestId('diff-gutter')).toHaveText('−');
  await expect(removed.getByTestId('diff-text')).toHaveText('    return user.active;');
  const del = await page.evaluate<string>(tokenBackground('--code-del'));
  await expect(removed).toHaveCSS('background-color', del);

  // Added rows: new number only, the + gutter, the --code-add background; the line numbers go on after the removed row.
  const added = page.locator('[data-row="23"]');
  await expect(added).toHaveAttribute('data-kind', 'add');
  await expect(added.getByTestId('diff-old')).toHaveText('');
  await expect(added.getByTestId('diff-new')).toHaveText('23');
  await expect(added.getByTestId('diff-gutter')).toHaveText('+');
  const add = await page.evaluate<string>(tokenBackground('--code-add'));
  await expect(added).toHaveCSS('background-color', add);
  await expect(page.locator('[data-row="24"]').getByTestId('diff-new')).toHaveText('24');

  // An unchanged row: both numbers, no gutter mark, no background.
  const context = page.locator('[data-row="21"]');
  await expect(context).toHaveAttribute('data-kind', 'ctx');
  await expect(context.getByTestId('diff-old')).toHaveText('22');
  await expect(context.getByTestId('diff-new')).toHaveText('22');
  await expect(context.getByTestId('diff-gutter')).toHaveText('');
  await expect(context).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  // The row after the removed one keeps counting: old 24 is new 25.
  const after = page.locator('[data-row="25"]');
  await expect(after.getByTestId('diff-old')).toHaveText('24');
  await expect(after.getByTestId('diff-new')).toHaveText('25');

  // The header says what changed in total.
  await expect(page.getByTestId('diff-stats')).toHaveText('+5 −3');

  // The last row was cut by the daemon and says so.
  await setScroll(page, await scrollHeightOf(page));
  const cut = page.locator('[data-row="60"]');
  await expect(cut).toHaveAttribute('data-cut', 'true');
  await expect(cut.locator('.cut-mark')).toHaveText('… cut');
  expect(await diffRows(page).count()).toBeGreaterThan(5);
});
