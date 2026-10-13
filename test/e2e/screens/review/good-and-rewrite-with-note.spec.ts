// e2e/review/good-and-rewrite-with-note (SPEC.md section 6, "Review marks";
// ADR-028, DC-136): G is Looks good; W saves Needs rewrite on the floor at
// once, and "Add note" adds a note to it, shown in the card and the file view;
// the mark is drawn as a notch and a roof plate and counted in the progress.

import { test } from '@playwright/test';
import { effects, floorIndex } from '../../support/effects.js';
import { SERVICE } from '../../support/hud.js';
import { APPLY, PLACE } from '../../support/panel.js';
import { card, cardButton, fileView, noteButton, openReview, rewriteDialog, selectFile } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

const NOTE = 'Round once, at the end: the total drifts by a cent.';

test('review/good-and-rewrite-with-note', async ({ page }) => {
  const { api, report } = await openReview(page);
  const mock = api.review(11);
  const apply = APPLY;
  const place = PLACE;

  await selectFile(page, SERVICE, apply);
  await page.keyboard.press('g');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Looks good');
  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.writes[0]).toMatchObject({ body: { target: { kind: 'symbol', id: apply }, mark: 'good' } });
  await expect(card(page).getByTestId('mark-note')).toHaveCount(0);

  // Needs rewrite on another floor: saved at once; "Add note" opens the note dialog for it, with the file's path.
  await selectFile(page, SERVICE, place);
  await cardButton(page, 'rewrite').click();
  await expect.poll(() => mock.writes.length).toBe(2);
  expect(mock.writes[1]).toMatchObject({ method: 'PUT', body: { snapshotId: 1, target: { kind: 'symbol', id: place }, mark: 'rewrite' } });
  await noteButton(page).click();
  const dialog = rewriteDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('heading')).toHaveText('Needs rewrite: OrdersService.place');
  await expect(dialog.getByTestId('rewrite-target')).toHaveText(SERVICE);
  await expect(dialog.getByTestId('rewrite-note')).toBeFocused();
  await dialog.getByTestId('rewrite-note').fill(NOTE);
  await expect(dialog.getByTestId('rewrite-note-count')).toHaveText(`${String(NOTE.length)} / 2000`);
  await dialog.getByTestId('rewrite-save').click();
  await expect(dialog).toBeHidden();
  // Focus is back on the button that opened it.
  await expect(noteButton(page)).toBeFocused();

  await expect(card(page).getByTestId('mark-current')).toHaveText('Needs rewrite');
  await expect(card(page).getByTestId('mark-note')).toHaveText(NOTE);
  await expect(fileView(page).getByTestId('mark-note')).toHaveText(NOTE);
  await expect.poll(() => mock.writes.length).toBe(3);
  expect(mock.writes[2]).toMatchObject({ method: 'PUT', body: { snapshotId: 1, target: { kind: 'symbol', id: place }, mark: 'rewrite', note: NOTE } });
  expect(mock.writes[2]?.body).not.toHaveProperty('lines');

  // The city: a notch on the floor, a plate on the roof.
  await expect.poll(async () => (await effects(page)).markers.filter((marker) => marker.kind === 'notch').map((marker) => [marker.file, marker.floor])).toEqual([
    [SERVICE, floorIndex(report, SERVICE, 'OrdersService.place')],
  ]);
  await expect.poll(async () => (await effects(page)).markers.some((marker) => marker.kind === 'rewrite' && marker.file === SERVICE)).toBe(true);
  // The progress counts it.
  await expect(page.getByTestId('progress-rewrite')).toHaveText('1 to rewrite');
});
