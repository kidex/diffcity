// e2e/review/snapshot-moved-refetch (ADR-028): a mark made against a snapshot
// that is no longer the latest, on a target that changed since, is refused with
// 409 `snapshot-moved`. The screen rolls the optimistic mark back, reads the
// state again (the older mark is now outdated, the snapshot id is the new one)
// and says why in a toast; the same mark made again goes through.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { card, openReview, selectFile } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/snapshot-moved-refetch', async ({ page }) => {
  const { api, report } = await openReview(page);
  const mock = api.review(11);
  await selectFile(page, GUARD, CAN_PLACE);
  await page.keyboard.press('g');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Looks good');
  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.writes[0]).toMatchObject({ body: { snapshotId: 1 } });

  // A newer snapshot changed the floor; the page has not heard of it yet (no SSE).
  mock.moveSnapshot([CAN_PLACE]);
  expect(mock.snapshotId).toBe(2);
  const reads = mock.reads;
  await page.keyboard.press('c');

  // Refused, rolled back (to the older mark), read again: that mark is outdated now.
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('toast')).toContainText('newer snapshot');
  await expect.poll(() => mock.reads).toBeGreaterThan(reads);
  await expect(card(page).getByTestId('mark-outdated')).toHaveText('changed since you checked it');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Looks good');
  expect(mock.writes[1]).toMatchObject({ method: 'PUT', body: { snapshotId: 1, mark: 'checked' } });
  expect(mock.marks.map((mark) => [mark.mark, mark.state])).toEqual([['good', 'outdated']]);

  // The screen now has the latest snapshot id: the same mark goes through.
  await page.keyboard.press('c');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  await expect(card(page).getByTestId('mark-outdated')).toHaveCount(0);
  await expect.poll(() => mock.writes.length).toBe(3);
  expect(mock.writes[2]).toMatchObject({ body: { snapshotId: 2, mark: 'checked' } });
  expect(mock.marks.map((mark) => [mark.mark, mark.state])).toEqual([['checked', 'current']]);

  // Another kind of refusal also rolls back, with the daemon's own wording.
  mock.failNext = { status: 409, code: 'archived' };
  await page.keyboard.press('g');
  await expect(page.getByTestId('toast')).toContainText('archived');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  expect(report.packages.length).toBeGreaterThan(0);
});
