// e2e/fileview/unavailable-state (ADR-027): when the daemon cannot read the
// objects the message says why, as the daemon wrote it. A request that fails
// shows its own message with a retry; an unchanged file shows its lines.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { diffRows, diffView, fileDiff, openDiff, rowsOf } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

const base = (path: string) => ({
  snapshotId: 1,
  head: 'aaaaaaa',
  path,
  language: 'typescript',
  stale: false,
  stats: { added: 0, removed: 0 },
  sizes: { before: null, after: null },
});

test('fileview/unavailable-state', async ({ page }) => {
  await openDiff(page, ({ path }) => ({ ...base(path), kind: 'unavailable', reason: 'The snapshot has no merge base; it is recomputed with the next one' }));
  const message = page.getByTestId('diff-unavailable');
  await expect(message).toBeVisible();
  await expect(message).toContainText('The diff is not available');
  await expect(message).toContainText('The snapshot has no merge base; it is recomputed with the next one');
  await expect(diffView(page)).toHaveAttribute('data-state', 'unavailable');
  await expect(diffRows(page)).toHaveCount(0);
});

test('fileview/load-error-retry', async ({ page }) => {
  let calls = 0;
  await openDiff(page, ({ path }) => {
    calls += 1;
    if (calls === 1) return { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
    return fileDiff({ path, rows: rowsOf([['ctx', 'a'], ['add', 'b']]) });
  });
  await expect(page.getByTestId('diff-error')).toContainText('The full diff could not be loaded');
  await page.getByTestId('diff-retry').click();
  await expect(diffRows(page)).toHaveCount(2);
  await expect(page.getByTestId('diff-error')).toHaveCount(0);
});

test('fileview/unchanged-state', async ({ page }) => {
  await openDiff(page, ({ path }) => fileDiff({ path, kind: 'unchanged', rows: rowsOf([['ctx', 'one'], ['ctx', 'two'], ['ctx', 'three']]) }));
  await expect(diffView(page)).toHaveAttribute('data-state', 'unchanged');
  await expect(page.getByTestId('diff-note')).toHaveText('This file is unchanged in this change');
  await expect(diffRows(page)).toHaveCount(3);
  await expect(page.locator('[data-kind="add"], [data-kind="del"]')).toHaveCount(0);
  await expect(page.getByTestId('hunk-counter')).toBeHidden();
});
