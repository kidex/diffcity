// e2e/panel/outside-spec-empty-when-null: the Outside the spec tab lists the
// files whose `inSpec` is false; when the Report has no spec (`inSpec` null
// everywhere) the tab shows an empty state and a zero counter, never a file.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { DISCOUNT, MAILER, noSpecReport, openPanel, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/outside-spec-empty-when-null', async ({ page }) => {
  await openPanel(page, noSpecReport());
  await expect(tab(page, 'outside')).toHaveText('Outside the spec0');
  await tab(page, 'outside').click();
  await expect(page.getByTestId('empty-outside')).toHaveText('This change has no spec to compare against');
  await expect(page.getByTestId('outside-file')).toHaveCount(0);
});

test('panel/outside-spec-lists-files-outside', async ({ page }) => {
  await openPanel(page);
  await tab(page, 'outside').click();
  const files = page.getByTestId('outside-file');
  await expect(files).toHaveCount(2);
  await expect(files.nth(0)).toContainText(DISCOUNT);
  await expect(files.nth(1)).toContainText(MAILER);
  await expect(page.getByTestId('empty-outside')).toHaveCount(0);
});
