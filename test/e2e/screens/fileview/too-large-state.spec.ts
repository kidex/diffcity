// e2e/fileview/too-large-state (ADR-027): a file over the limits shows a
// message with the stats the daemon took from `git diff --numstat`, and no rows.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { diffRows, diffView, openDiff } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

test('fileview/too-large-state', async ({ page }) => {
  await openDiff(page, ({ path }) => ({
    snapshotId: 1,
    head: 'aaaaaaa',
    path,
    language: 'typescript',
    kind: 'too-large',
    reason: 'More than 50,000 lines',
    stale: false,
    stats: { added: 61_234, removed: 310 },
    sizes: { before: 1_500_000, after: 3_000_000 },
  }));
  const message = page.getByTestId('diff-too-large');
  await expect(message).toBeVisible();
  await expect(message).toContainText('This file is too large to show here');
  await expect(message).toContainText('+61234 −310 lines');
  await expect(message).toContainText('More than 50,000 lines');
  await expect(diffView(page)).toHaveAttribute('data-state', 'too-large');
  await expect(diffRows(page)).toHaveCount(0);
  await expect(page.getByTestId('hunk-counter')).toBeHidden();
});
