// e2e/review/keys-ignored-in-dialog-and-inputs (ADR-028): with the rewrite
// dialog open, c, g, w and u typed in its note are letters: no mark is sent.
// Esc closes the dialog and focus returns to what opened it.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { cardButton, openReview, rewriteDialog, selectFile } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/keys-ignored-in-dialog-and-inputs', async ({ page }) => {
  const { api } = await openReview(page);
  const mock = api.review(11);
  await selectFile(page, GUARD, CAN_PLACE);
  await cardButton(page, 'rewrite').click();
  const dialog = rewriteDialog(page);
  const note = dialog.getByTestId('rewrite-note');
  await expect(note).toBeFocused();

  await page.keyboard.type('cgwu');
  await expect(note).toHaveValue('cgwu');
  await page.waitForTimeout(400);
  expect(mock.writes).toHaveLength(0);
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(cardButton(page, 'rewrite')).toBeFocused();
  expect(mock.writes).toHaveLength(0);
});
