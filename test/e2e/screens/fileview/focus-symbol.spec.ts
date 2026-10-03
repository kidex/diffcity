// e2e/fileview/focus-symbol (SPEC.md section 6): the diff opens at the focused
// symbol when a floor was clicked (the route is asked for it and answers
// `focus`), at the first hunk otherwise, and a later focus scrolls to its lines.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { project, sceneExpect as expect, selectedFloor, waitForCityAttribute } from '../../support/scene.js';
import { CAN_PLACE } from '../../support/panel.js';
import type { DiffRequest } from '../../support/fileview.js';
import { guardDiff, openDiff, rowTop, scrollHeightOf, scrollOf, setScroll } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

test('fileview/focus-symbol', async ({ page }) => {
  const asked: DiffRequest[] = [];
  await openDiff(
    page,
    (request) => {
      asked.push(request);
      return guardDiff({ symbolId: request.symbol });
    },
    { floor: CAN_PLACE },
  );
  // The route was asked for the symbol of the floor that was clicked.
  await expect.poll(() => selectedFloor(page)).toBe(CAN_PLACE);
  expect(asked.map((request) => [request.path, request.symbol])).toEqual([[GUARD, CAN_PLACE]]);

  // Open at its first row: the symbol's rows are marked, the class's other rows are not.
  const first = page.locator('[data-row="21"]');
  await expect(first).toBeVisible();
  await expect(page.getByTestId('hunk-counter')).toHaveText('1 / 3');
  for (const row of [21, 22, 23, 24]) await expect(page.locator(`[data-row="${String(row)}"]`)).toHaveClass(/\bfocus\b/);
  await expect(page.locator('[data-row="25"]')).not.toHaveClass(/\bfocus\b/);
  await expect(page.locator('[data-row="20"]')).not.toHaveClass(/\bfocus\b/);
  expect(await rowTop(page, 21)).toBeLessThan(19 * 4);

  // Scrolled away (with the folds open, the file is longer than the viewport), a click on the floor brings the reader back to it.
  const folds = page.getByTestId('diff-fold');
  while ((await folds.count()) > 0) await folds.first().dispatchEvent('click');
  await setScroll(page, await scrollHeightOf(page));
  await expect.poll(() => rowTop(page, 21)).toBeLessThan(0);
  const floor = await project(page, GUARD, CAN_PLACE);
  await page.mouse.click(floor.x, floor.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect.poll(() => rowTop(page, 21)).toBeGreaterThanOrEqual(0);
  // Two rows of context above row 21, with every fold open.
  expect(await scrollOf(page)).toBe(19 * 19);
  expect(asked).toHaveLength(1);
});
