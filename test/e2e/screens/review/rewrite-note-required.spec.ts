// e2e/review/rewrite-note-required (ADR-028): Needs rewrite needs a note of 1
// to 2,000 characters. An empty note, one of spaces and one that is too long are
// blocked in the dialog with a message and nothing is sent; Esc closes the
// dialog, returns focus and leaves the selection alone.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { card, cardButton, openReview, rewriteDialog, selectFile } from '../../support/review.js';
import { selected, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/rewrite-note-required', async ({ page }) => {
  const { api } = await openReview(page);
  const mock = api.review(11);
  await selectFile(page, GUARD, CAN_PLACE);
  await cardButton(page, 'rewrite').click();
  const dialog = rewriteDialog(page);
  const note = dialog.getByTestId('rewrite-note');
  const error = dialog.getByTestId('rewrite-note-error');
  await expect(error).toBeHidden();

  // Empty: blocked, message, focus on the field, nothing sent.
  await dialog.getByTestId('rewrite-save').click();
  await expect(error).toBeVisible();
  await expect(error).toContainText('a note is required');
  await expect(note).toHaveAttribute('aria-invalid', 'true');
  await expect(note).toBeFocused();
  await expect(dialog).toBeVisible();

  // Spaces and line breaks only: still empty.
  await note.fill('  \n  ');
  await dialog.getByTestId('rewrite-save').click();
  await expect(error).toBeVisible();

  // Typing a note clears the message.
  await note.fill('Check the owner against the session, not the body.');
  await expect(error).toBeHidden();
  await expect(note).not.toHaveAttribute('aria-invalid', 'true');

  // Past 2,000 characters: blocked with the excess.
  await note.fill('x'.repeat(2001));
  await dialog.getByTestId('rewrite-save').click();
  await expect(error).toContainText('1 characters too long');
  await expect(dialog).toBeVisible();

  expect(mock.writes).toEqual([]);
  expect(mock.marks).toEqual([]);

  // Esc closes the dialog and gives focus back; the selection and the marks stay as they were.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(cardButton(page, 'rewrite')).toBeFocused();
  expect(await selected(page)).toBe(GUARD);
  await expect(card(page).getByTestId('mark-none')).toHaveText('Not marked');

  // Exactly 2,000 characters go through.
  await cardButton(page, 'rewrite').click();
  await rewriteDialog(page).getByTestId('rewrite-note').fill('y'.repeat(2000));
  await rewriteDialog(page).getByTestId('rewrite-save').click();
  await expect(rewriteDialog(page)).toBeHidden();
  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.marks[0]?.note).toHaveLength(2000);
});
