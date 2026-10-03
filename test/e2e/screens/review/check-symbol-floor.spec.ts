// e2e/review/check-symbol-floor (SPEC.md section 6, "Review marks"; ADR-028):
// with a floor focused, C marks that symbol, not the file. The city draws the
// floor quiet, and a file whose changed floors are all marked counts as done in
// the progress without a file mark.

import { test } from '@playwright/test';
import { effects, floorIndex } from '../../support/effects.js';
import { GUARD, SERVICE } from '../../support/hud.js';
import { APPLY, CAN_PLACE } from '../../support/panel.js';
import { card, cardButton, expectProgress, openReview, selectFile } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/check-symbol-floor', async ({ page }) => {
  const { api, report } = await openReview(page);
  const mock = api.review(11);
  const canPlace = floorIndex(report, GUARD, 'OrderGuard.canPlace');

  await selectFile(page, GUARD, CAN_PLACE);
  await expect(card(page).getByTestId('mark-target')).toHaveText('Mark floor OrderGuard.canPlace');
  await page.keyboard.press('c');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.writes[0]).toMatchObject({ method: 'PUT', body: { snapshotId: 1, target: { kind: 'symbol', id: CAN_PLACE }, mark: 'checked' } });

  // The floor is drawn checked; the guard's only changed floor is marked, so the file is done.
  await expect.poll(async () => (await effects(page)).checked[GUARD]).toEqual([canPlace]);
  await expectProgress(page, '1 of 2 files that need your eyes checked');

  // Another floor of another file: its own mark, and the first one stays.
  await selectFile(page, SERVICE, APPLY);
  await expect(card(page).getByTestId('mark-target')).toHaveText('Mark floor OrdersService.applyDiscount');
  await expect(card(page).getByTestId('mark-none')).toBeVisible();
  await cardButton(page, 'good').click();
  await expect(card(page).getByTestId('mark-current')).toHaveText('Looks good');
  await expect.poll(() => mock.marks.length).toBe(2);
  // The service has five changed floors: one marked does not finish it, and it is no attention file anyway.
  await expect.poll(async () => (await effects(page)).checked[SERVICE]).toEqual([floorIndex(report, SERVICE, 'OrdersService.applyDiscount')]);
  await expect.poll(async () => (await effects(page)).markers.filter((marker) => marker.kind === 'check').map((marker) => marker.file)).toEqual([GUARD]);
  await expectProgress(page, '1 of 2 files that need your eyes checked');
});
