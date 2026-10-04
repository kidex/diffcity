// e2e/a11y/shortcuts-ignored-in-inputs (DC-89): the screen's keys ([ ] J K N R
// Esc and the review marks) are ignored while typing in a text field and
// behind a dialog: the text is typed, the selection and the camera stay.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { openReview, rewriteDialog, selectFile, summaryDialog } from '../../support/review.js';
import { camera, selected, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

const KEYS = ['[', ']', 'j', 'k', 'J', 'K', 'n', 'N', 'r', 'c', 'g', 'u', 'w'];

test('a11y/shortcuts-ignored-in-inputs', async ({ page }) => {
  const { api } = await openReview(page);
  await selectFile(page, GUARD);
  const view = await camera(page);

  // A text field of the page (the screen has none of its own outside dialogs): nothing it types is a shortcut.
  await page.evaluate(`(() => {
    const field = document.createElement('input');
    field.type = 'text';
    field.id = 'probe-field';
    document.body.append(field);
    field.focus();
  })()`);
  await page.keyboard.type(KEYS.join(''));
  expect(await page.inputValue('#probe-field')).toBe(KEYS.join(''));
  expect(await selected(page)).toBe(GUARD);
  expect(await camera(page)).toEqual(view);
  expect(api.review(11).writes).toHaveLength(0);
  // Escape in the field does not clear the selection either.
  await page.keyboard.press('Escape');
  expect(await selected(page)).toBe(GUARD);
  await page.evaluate(`document.getElementById('probe-field').remove()`);

  // The "Needs rewrite" dialog's textarea.
  await page.keyboard.press('w');
  await expect(rewriteDialog(page)).toBeVisible();
  await page.keyboard.type(KEYS.slice(0, 8).join(''));
  await expect(rewriteDialog(page).getByRole('textbox').first()).toHaveValue(KEYS.slice(0, 8).join(''));
  expect(await selected(page)).toBe(GUARD);
  expect(api.review(11).writes).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(rewriteDialog(page)).toBeHidden();
  expect(await selected(page)).toBe(GUARD);

  // The summary dialog: with focus on a button, the keys still do not reach the screen.
  await page.getByTestId('review-summary').click();
  await expect(summaryDialog(page)).toBeVisible();
  for (const key of ['[', ']', 'j', 'c', 'r']) await page.keyboard.press(key);
  expect(await selected(page)).toBe(GUARD);
  expect(await camera(page)).toEqual(view);
  expect(api.review(11).writes).toHaveLength(0);
});
