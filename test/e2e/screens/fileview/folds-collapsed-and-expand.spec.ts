// e2e/fileview/folds-collapsed-and-expand (SPEC.md section 6): runs of
// unchanged lines are folded by default, one line "N unchanged lines" each;
// a click opens a fold, and the line at the top of the viewport stays where
// it was, also when the fold is above it.

import { test, type Page } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { diffRows, openDiff, scrollOf, serveGuard, setScroll } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

/** The index of the first row at or below the viewport's top edge, and how far its top is from the edge. */
const topRow = (page: Page): Promise<{ row: number; offset: number }> =>
  page.evaluate<{ row: number; offset: number }>(`(() => {
    const edge = document.querySelector('[data-testid="diff-viewport"]').getBoundingClientRect().top;
    const rows = [...document.querySelectorAll('[data-testid="diff-row"]')]
      .map((node) => ({ row: Number(node.dataset.row), top: node.getBoundingClientRect().top - edge }))
      .filter((entry) => entry.top > -19);
    rows.sort((a, b) => a.row - b.row);
    return { row: rows[0].row, offset: rows[0].top };
  })()`);

test('fileview/folds-collapsed-and-expand', async ({ page }) => {
  await openDiff(page, serveGuard());
  const folds = page.getByTestId('diff-fold');

  // Collapsed by default: the unchanged run between the hunks is one line, and none of its rows is in the DOM.
  const second = page.locator('[data-testid="diff-fold"][data-fold="28"]');
  await expect(second).toBeVisible();
  await expect(second).toHaveText('16 unchanged lines');
  await expect(page.locator('[data-row="30"]')).toHaveCount(0);
  await expect(folds.first()).toHaveAttribute('data-fold', '0');
  await expect(folds.first()).toHaveText('19 unchanged lines');

  // Opening it brings its rows back and leaves the row at the top where it was.
  const before = await topRow(page);
  const scroll = await scrollOf(page);
  await second.click();
  await expect(page.locator('[data-row="30"]')).toBeVisible();
  await expect(page.locator('[data-row="30"]').getByTestId('diff-text')).toHaveText('  // untouched 6');
  await expect(second).toHaveCount(0);
  expect(await topRow(page)).toEqual(before);
  expect(await scrollOf(page)).toBe(scroll);

  // A fold above the viewport: scroll a little below the first hunk, open the first fold from
  // the DOM (it is out of sight), and the same row stays at the top.
  await setScroll(page, 38 + 19 * 3);
  await expect(folds.first()).toHaveAttribute('data-fold', '0');
  const reading = await topRow(page);
  await folds.first().dispatchEvent('click');
  await expect(page.locator('[data-row="3"]')).toHaveCount(1);
  await expect.poll(() => topRow(page)).toEqual(reading);
  expect(await scrollOf(page)).toBeGreaterThan(38);

  // Everything above is readable now: back at the top is the file's first line.
  await setScroll(page, 0);
  await expect(page.locator('[data-row="0"]').getByTestId('diff-text')).toHaveText("import { Order, User } from './types';");
  expect(await diffRows(page).count()).toBeGreaterThan(10);
});
