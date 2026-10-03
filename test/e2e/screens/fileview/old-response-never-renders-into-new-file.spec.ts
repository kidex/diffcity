// e2e/fileview/old-response-never-renders-into-new-file (ADR-027): the first
// file's diff answer is held while a second file is opened; when the first
// answer is released late, the view keeps showing the second file's rows.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { DISCOUNT } from '../../support/panel.js';
import { sceneExpect as expect, project, waitForCityAttribute } from '../../support/scene.js';
import { diffRows, fileDiff, guardDiff, openDiff, rowsOf } from '../../support/fileview.js';
import type { DiffRequest } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

test('fileview/old-response-never-renders-into-new-file', async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked: string[] = [];
  await openDiff(page, async (request: DiffRequest) => {
    asked.push(request.path);
    if (request.path === GUARD) {
      await gate;
      return guardDiff({ symbolId: request.symbol });
    }
    return fileDiff({ path: request.path, rows: rowsOf([['ctx', 'second-file line one'], ['add', 'second-file added line']]) });
  });
  // The first file is open and its answer is held.
  await expect.poll(() => asked.includes(GUARD)).toBe(true);
  await expect(diffRows(page)).toHaveCount(0);

  const second = await project(page, DISCOUNT);
  await page.mouse.click(second.x, second.y);
  await waitForCityAttribute(page, 'data-selected', DISCOUNT);
  await expect(diffRows(page)).toHaveCount(2);
  await expect(diffRows(page).first()).toContainText('second-file line one');

  // The late answer of the first file arrives.
  release();
  await page.waitForTimeout(800);
  await expect(diffRows(page)).toHaveCount(2);
  await expect(page.getByTestId('diff-view')).not.toContainText('OrderGuard');
  await expect(diffRows(page).last()).toContainText('second-file added line');
});
