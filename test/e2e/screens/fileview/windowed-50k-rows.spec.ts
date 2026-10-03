// e2e/fileview/windowed-50k-rows (ADR-027): a diff of 50,000 rows keeps only
// the visible rows and a little overscan in the DOM, scrolls, jumps between
// hunks and opens a fold of 49,000 lines without a stall.

import { test, type Page } from '@playwright/test';
import { SERVICE } from '../../support/hud.js';
import { project, sceneExpect as expect, waitForCityAttribute } from '../../support/scene.js';
import type { Line } from '../../support/fileview.js';
import { fileDiff, openDiff, rowsOf, rowTop, scrollHeightOf, scrollOf, setScroll } from '../../support/fileview.js';
import { GUARD } from '../../support/hud.js';

test.describe.configure({ timeout: 180_000 });

const ROWS = 50_000;

/** 50,000 rows with a change every 10 rows (2 removed, 3 added, 5 unchanged): hunks every 10 rows and nothing long enough to fold. */
function busy(): Line[] {
  const script: Line[] = [];
  for (let n = 0; script.length < ROWS; n++) {
    script.push(['del', `old ${String(n)}`], ['del', `old b ${String(n)}`], ['add', `new ${String(n)}`, [[0, 3, 'kw']]], ['add', `new b ${String(n)}`], ['add', `new c ${String(n)}`]);
    for (let k = 0; k < 5; k++) script.push(['ctx', `  context ${String(n)} ${String(k)}`]);
  }
  return script.slice(0, ROWS);
}

/** 100 changed rows, then 49,900 unchanged: one fold. */
function folded(): Line[] {
  const script: Line[] = [];
  for (let n = 0; n < 50; n++) script.push(['del', `old ${String(n)}`], ['add', `new ${String(n)}`]);
  while (script.length < ROWS) script.push(['ctx', `  unchanged ${String(script.length)}`]);
  return script;
}

const domRows = (page: Page): Promise<number> => page.evaluate<number>(`document.querySelectorAll('[data-testid="diff-row"], [data-testid="diff-fold"]').length`);

test('fileview/windowed-50k-rows', async ({ page }) => {
  const busyRows = rowsOf(busy());
  const foldedRows = rowsOf(folded());
  await openDiff(page, ({ path }) => fileDiff({ path, rows: path === SERVICE ? foldedRows : busyRows }), { file: GUARD });

  const view = page.getByTestId('diff-view');
  await expect(view).toHaveAttribute('data-rows', String(ROWS), { timeout: 60_000 });
  // A window, not the file.
  expect(await domRows(page)).toBeLessThan(150);
  expect(await domRows(page)).toBeGreaterThan(10);
  await expect(page.getByTestId('hunk-counter')).toHaveText('1 / 5000');

  // Scroll to the middle: the rows there, quickly, and still a window.
  const started = Date.now();
  await setScroll(page, 25_000 * 19);
  await expect(page.locator('[data-row="25010"]')).toBeVisible({ timeout: 5_000 });
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(await domRows(page)).toBeLessThan(150);
  await expect(page.locator('[data-row="25010"]').getByTestId('diff-text')).toHaveText('old 2501');

  // The end of the file.
  await setScroll(page, await scrollHeightOf(page));
  await expect(page.locator(`[data-row="${String(ROWS - 1)}"]`)).toBeVisible();
  expect(await domRows(page)).toBeLessThan(150);

  // Hunk jumps work through the window: ten of them, one key each.
  await setScroll(page, 0);
  await expect(page.getByTestId('hunk-counter')).toHaveText('1 / 5000');
  for (let n = 0; n < 10; n++) await page.keyboard.press('n');
  await expect(page.getByTestId('hunk-counter')).toHaveText('11 / 5000');
  // The 11th hunk starts at row 100.
  await expect.poll(() => rowTop(page, 100)).toBeLessThan(19 * 4);
  expect(await domRows(page)).toBeLessThan(150);

  // A fold of 49,900 lines: collapsed, then open, and the view stays a window.
  const service = await project(page, SERVICE);
  await page.mouse.click(service.x, service.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  await expect(view).toHaveAttribute('data-hunks', '1', { timeout: 60_000 });
  // The fold comes after the 100 changed rows.
  await setScroll(page, 100 * 19 - 200);
  const fold = page.getByTestId('diff-fold');
  await expect(fold).toHaveText('49897 unchanged lines');
  const before = await scrollOf(page);
  await fold.click();
  await expect(fold).toHaveCount(0);
  await expect(page.locator('[data-row="110"]')).toBeVisible();
  expect(await scrollOf(page)).toBe(before);
  expect(await domRows(page)).toBeLessThan(150);
  await setScroll(page, await scrollHeightOf(page));
  await expect(page.locator(`[data-row="${String(ROWS - 1)}"]`)).toBeVisible();
});
