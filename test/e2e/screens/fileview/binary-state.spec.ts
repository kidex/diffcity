// e2e/fileview/binary-state (ADR-027): a binary file shows a message with its
// sizes, no rows and no hunk keys.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { diffRows, diffView, openDiff } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

test('fileview/binary-state', async ({ page }) => {
  await openDiff(page, ({ path }) => ({
    snapshotId: 1,
    head: 'aaaaaaa',
    path,
    language: 'binary',
    kind: 'binary',
    stale: false,
    stats: { added: 0, removed: 0 },
    sizes: { before: 1024, after: 2048 },
  }));
  const message = page.getByTestId('diff-binary');
  await expect(message).toBeVisible();
  await expect(message).toContainText('Binary file: its contents are not shown');
  await expect(message).toContainText('before 1.0 KiB, after 2.0 KiB');
  await expect(diffView(page)).toHaveAttribute('data-state', 'binary');
  await expect(diffRows(page)).toHaveCount(0);
  await expect(page.getByTestId('hunk-counter')).toBeHidden();
  await expect(page.getByTestId('diff-viewport')).toBeHidden();
  // The keys do nothing here.
  await page.keyboard.press('n');
  await expect(diffRows(page)).toHaveCount(0);
});
