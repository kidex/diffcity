// e2e/review/rewrite-without-note (ADR-028 as amended by DC-135, DC-136): W
// marks Needs rewrite at once, with no dialog and no note. The note stays
// available from the bar ("Add note", then "Edit note"), optional: an empty
// one saves the mark without a note; one past 2,000 characters is blocked in
// the dialog with a message and nothing is sent; Esc closes the dialog, gives
// focus back and leaves the selection and the mark alone.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { card, cardButton, noteButton, openReview, rewriteDialog, selectFile } from '../../support/review.js';
import { selected, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/rewrite-without-note', async ({ page }) => {
  const { api } = await openReview(page);
  const mock = api.review(11);
  await selectFile(page, GUARD, CAN_PLACE);
  // Before a Needs rewrite mark there is no note to add.
  await expect(noteButton(page)).toBeHidden();

  // W: saved at once, no dialog, no note.
  await page.keyboard.press('w');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Needs rewrite');
  await expect(rewriteDialog(page)).toHaveCount(0);
  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.writes[0]).toMatchObject({ method: 'PUT', body: { target: { kind: 'symbol', id: CAN_PLACE }, mark: 'rewrite' } });
  expect(mock.writes[0]?.body).not.toHaveProperty('note');
  expect(mock.marks[0]).toMatchObject({ mark: 'rewrite', note: null });
  await expect(card(page).getByTestId('mark-note')).toHaveCount(0);
  await expect(page.getByTestId('progress-rewrite')).toHaveText('1 to rewrite');

  // The note is optional: "Add note" opens the dialog, and saving it empty keeps the mark without one.
  await expect(noteButton(page)).toHaveText('Add note');
  await noteButton(page).click();
  const dialog = rewriteDialog(page);
  const note = dialog.getByTestId('rewrite-note');
  const error = dialog.getByTestId('rewrite-note-error');
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('');
  await expect(note).not.toHaveAttribute('required');
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => mock.writes.length).toBe(2);
  expect(mock.writes[1]?.body).not.toHaveProperty('note');

  // Spaces only count as no note.
  await noteButton(page).click();
  await note.fill('  \n  ');
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => mock.writes.length).toBe(3);
  expect(mock.writes[2]?.body).not.toHaveProperty('note');

  // Past 2,000 characters: blocked with the excess, nothing sent; a shorter note clears the message.
  await noteButton(page).click();
  await note.fill('x'.repeat(2001));
  await dialog.getByTestId('rewrite-save').click();
  await expect(error).toContainText('1 characters too long');
  await expect(note).toHaveAttribute('aria-invalid', 'true');
  await expect(note).toBeFocused();
  await expect(dialog).toBeVisible();
  await note.fill('x'.repeat(2000));
  await expect(error).toBeHidden();
  expect(mock.writes).toHaveLength(3);

  // Esc closes the dialog and gives focus back; the selection and the mark stay as they were.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(noteButton(page)).toBeFocused();
  expect(await selected(page)).toBe(GUARD);
  await expect(card(page).getByTestId('mark-current')).toHaveText('Needs rewrite');
  expect(mock.writes).toHaveLength(3);

  // Exactly 2,000 characters go through; the button then says "Edit note".
  await noteButton(page).click();
  await note.fill('y'.repeat(2000));
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => mock.writes.length).toBe(4);
  expect(mock.marks[0]?.note).toHaveLength(2000);
  await expect(noteButton(page)).toHaveText('Edit note');

  // Undo takes the mark, and the note button, away.
  await cardButton(page, 'undo').click();
  await expect(card(page).getByTestId('mark-none')).toHaveText('Not marked');
  await expect(noteButton(page)).toBeHidden();
});
