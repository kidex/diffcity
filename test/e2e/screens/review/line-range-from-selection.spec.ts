// e2e/review/line-range-from-selection (SPEC.md section 6, "Review marks";
// ADR-027, ADR-028, DC-136): Needs rewrite (W) is saved at once with the lines
// picked in the file view's diff as its range; with nothing picked it is sent
// without `lines`. The note dialog ("Add note") starts from the pick too, keeps
// the range editable and refuses a half-filled or backwards one. W again on a
// noted mark keeps its note and takes the new pick.

import { test, type Page } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { diffView, serveGuard } from '../../support/fileview.js';
import { fileView, openReview, rewriteDialog, selectFile, viewButton } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

const NOTE = 'The owner check reads the body.';
const viewNote = (page: Page) => fileView(page).getByTestId('mark-note-edit');

test('review/line-range-from-selection', async ({ page }) => {
  const { api } = await openReview(page, { api: { diff: serveGuard() } });
  const mock = api.review(11);
  await selectFile(page, GUARD, CAN_PLACE);
  const row = (index: number) => page.locator(`[data-row="${String(index)}"]`);
  await expect(diffView(page)).toBeVisible();

  // Nothing picked: Needs rewrite goes at once, with no range and no note; the note dialog's range is empty.
  await viewButton(page, 'rewrite').click();
  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.writes[0]).toMatchObject({ body: { target: { kind: 'symbol', id: CAN_PLACE }, mark: 'rewrite' } });
  expect(mock.writes[0]?.body).not.toHaveProperty('lines');
  expect(mock.writes[0]?.body).not.toHaveProperty('note');
  await viewNote(page).click();
  const dialog = rewriteDialog(page);
  await expect(dialog.getByTestId('rewrite-lines-start')).toHaveValue('');
  await expect(dialog.getByTestId('rewrite-lines-end')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Pick old lines 23 to 24 in the diff (a click, then Shift+click): W saves them as the range.
  await row(22).getByTestId('diff-old').click();
  await row(25).getByTestId('diff-old').click({ modifiers: ['Shift'] });
  await expect(diffView(page)).toHaveAttribute('data-range', 'old 23-24');
  await viewButton(page, 'rewrite').click();
  await expect.poll(() => mock.writes.length).toBe(2);
  expect(mock.writes[1]).toMatchObject({ body: { mark: 'rewrite', lines: { side: 'old', start: 23, end: 24 } } });
  await expect(fileView(page).getByTestId('mark-lines')).toHaveText('old lines 23–24');

  // The note dialog starts from the pick; the range stays editable, a half-filled or backwards one is refused.
  await viewNote(page).click();
  await expect(dialog.getByTestId('rewrite-lines-side')).toHaveValue('old');
  await expect(dialog.getByTestId('rewrite-lines-start')).toHaveValue('23');
  await expect(dialog.getByTestId('rewrite-lines-end')).toHaveValue('24');
  await dialog.getByTestId('rewrite-note').fill(NOTE);
  await dialog.getByTestId('rewrite-lines-end').fill('');
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog.getByTestId('rewrite-lines-error')).toBeVisible();
  await dialog.getByTestId('rewrite-lines-end').fill('22');
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog.getByTestId('rewrite-lines-error')).toBeVisible();
  expect(mock.writes).toHaveLength(2);
  await dialog.getByTestId('rewrite-lines-end').fill('25');
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => mock.writes.length).toBe(3);
  expect(mock.writes[2]).toMatchObject({
    body: { target: { kind: 'symbol', id: CAN_PLACE }, mark: 'rewrite', note: NOTE, lines: { side: 'old', start: 23, end: 25 } },
  });
  await expect(fileView(page).getByTestId('mark-lines')).toHaveText('old lines 23–25');
  await expect(viewNote(page)).toHaveText('Edit note');

  // A pick in another place, then W again: the note is kept, the range is the new pick.
  await row(23).getByTestId('diff-new').click();
  await viewButton(page, 'rewrite').click();
  await expect.poll(() => mock.writes.length).toBe(4);
  expect(mock.writes[3]).toMatchObject({ body: { mark: 'rewrite', note: NOTE, lines: { side: 'new', start: 23, end: 23 } } });
  await viewNote(page).click();
  await expect(dialog.getByTestId('rewrite-lines-side')).toHaveValue('new');
  await expect(dialog.getByTestId('rewrite-lines-start')).toHaveValue('23');
  await expect(dialog.getByTestId('rewrite-lines-end')).toHaveValue('23');
  await expect(dialog.getByTestId('rewrite-note')).toHaveValue(NOTE);
});
