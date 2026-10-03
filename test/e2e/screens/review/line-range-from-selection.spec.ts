// e2e/review/line-range-from-selection (SPEC.md section 6, "Review marks";
// ADR-027, ADR-028): the lines picked in the file view's diff prefill the range
// of the Needs rewrite dialog, which can still be edited; the saved mark carries
// { side, start, end } and shows it. With nothing picked the range is empty and
// the mark is sent without `lines`.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { diffView, serveGuard } from '../../support/fileview.js';
import { fileView, openReview, rewriteDialog, selectFile, viewButton } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/line-range-from-selection', async ({ page }) => {
  const { api } = await openReview(page, { api: { diff: serveGuard() } });
  const mock = api.review(11);
  await selectFile(page, GUARD, CAN_PLACE);
  const row = (index: number) => page.locator(`[data-row="${String(index)}"]`);
  await expect(diffView(page)).toBeVisible();

  // Nothing picked yet: the range fields are empty.
  await viewButton(page, 'rewrite').click();
  const dialog = rewriteDialog(page);
  await expect(dialog.getByTestId('rewrite-lines-start')).toHaveValue('');
  await expect(dialog.getByTestId('rewrite-lines-end')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Pick old lines 23 to 24 in the diff (a click, then Shift+click).
  await row(22).getByTestId('diff-old').click();
  await row(25).getByTestId('diff-old').click({ modifiers: ['Shift'] });
  await expect(diffView(page)).toHaveAttribute('data-range', 'old 23-24');

  await viewButton(page, 'rewrite').click();
  await expect(dialog.getByTestId('rewrite-lines-side')).toHaveValue('old');
  await expect(dialog.getByTestId('rewrite-lines-start')).toHaveValue('23');
  await expect(dialog.getByTestId('rewrite-lines-end')).toHaveValue('24');

  // The range stays editable; a half-filled or backwards one is refused with a message.
  await dialog.getByTestId('rewrite-note').fill('The owner check reads the body.');
  await dialog.getByTestId('rewrite-lines-end').fill('');
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog.getByTestId('rewrite-lines-error')).toBeVisible();
  await dialog.getByTestId('rewrite-lines-end').fill('22');
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog.getByTestId('rewrite-lines-error')).toBeVisible();
  expect(mock.writes).toEqual([]);
  await dialog.getByTestId('rewrite-lines-end').fill('25');
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.writes[0]).toMatchObject({
    body: { target: { kind: 'symbol', id: CAN_PLACE }, mark: 'rewrite', note: 'The owner check reads the body.', lines: { side: 'old', start: 23, end: 25 } },
  });
  await expect(fileView(page).getByTestId('mark-lines')).toHaveText('old lines 23–25');

  // Re-opening the dialog on a mark with a range and a pick in another place starts from the pick.
  await row(23).getByTestId('diff-new').click();
  await viewButton(page, 'rewrite').click();
  await expect(dialog.getByTestId('rewrite-lines-side')).toHaveValue('new');
  await expect(dialog.getByTestId('rewrite-lines-start')).toHaveValue('23');
  await expect(dialog.getByTestId('rewrite-lines-end')).toHaveValue('23');
  // The note of the mark being replaced is kept for editing.
  await expect(dialog.getByTestId('rewrite-note')).toHaveValue('The owner check reads the body.');
});
