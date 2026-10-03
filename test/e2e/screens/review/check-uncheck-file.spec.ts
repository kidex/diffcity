// e2e/review/check-uncheck-file (SPEC.md section 6, "Review marks"; ADR-028):
// Checked and undo on a whole file, from the selection card, from the file
// view's header and from the keys C and U. The write goes to the daemon with
// the snapshot the reviewer is looking at; the card, the file view and the
// progress follow at once.

import { test } from '@playwright/test';
import { CAN_PLACE } from '../../support/panel.js';
import { GUARD } from '../../support/hud.js';
import { card, cardButton, expectProgress, fileView, openReview, selectFile, viewButton } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/check-uncheck-file', async ({ page }) => {
  const { api } = await openReview(page);
  const mock = api.review(11);
  await expectProgress(page, '0 of 2 files that need your eyes checked');
  // Nothing is selected: no buttons yet.
  await expect(card(page)).toBeHidden();

  // A click lands on a floor; "This file" puts the mark on the whole file.
  await selectFile(page, GUARD, CAN_PLACE);
  await expect(card(page).getByTestId('mark-target')).toHaveText('Mark floor OrderGuard.canPlace');
  await expect(cardButton(page, 'undo')).toBeDisabled();
  await card(page).getByTestId('mark-scope-file').click();
  await expect(card(page).getByTestId('mark-target')).toHaveText('Mark this file');

  await cardButton(page, 'checked').click();
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  await expect(fileView(page).getByTestId('mark-current')).toHaveText('Checked');
  await expect(cardButton(page, 'checked')).toHaveAttribute('aria-pressed', 'true');
  await expectProgress(page, '1 of 2 files that need your eyes checked');
  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.writes[0]).toMatchObject({ method: 'PUT', path: '/marks', body: { snapshotId: 1, target: { kind: 'file', id: GUARD }, mark: 'checked' } });

  // Undo from the file view's header.
  await viewButton(page, 'undo').click();
  await expect(card(page).getByTestId('mark-none')).toHaveText('Not marked');
  await expect(cardButton(page, 'undo')).toBeDisabled();
  await expectProgress(page, '0 of 2 files that need your eyes checked');
  await expect.poll(() => mock.writes.length).toBe(2);
  expect(mock.writes[1]).toMatchObject({ method: 'DELETE', path: '/marks', query: `kind=file&id=${encodeURIComponent(GUARD)}` });
  expect(mock.marks).toEqual([]);

  // The keys C and U do the same, from the file view's button too.
  await viewButton(page, 'checked').click();
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  await page.keyboard.press('u');
  await expect(card(page).getByTestId('mark-none')).toHaveText('Not marked');
  await page.keyboard.press('c');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  expect(mock.marks.map((mark) => [mark.targetKind, mark.targetId, mark.mark])).toEqual([['file', GUARD, 'checked']]);

  // G replaces the mark (one mark per target), and Esc clears the selection with the buttons.
  await page.keyboard.press('g');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Looks good');
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
});
