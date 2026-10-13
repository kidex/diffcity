// e2e/approve/moved (DC-116, ADR-019, ADR-036): an approved change whose head
// moves is reset to unreviewed by the daemon. The UI computes none of it: on
// SSE `changes` and `review` the route refetches the change and the marks, the
// badge goes, and the plain Approve goes back to "Check the rest and approve"
// because the mark on the tier 1 file that changed went outdated. A
// confirmation of "Check the rest and approve" whose list went stale under it
// (`snapshot-moved`, `remaining-changed`) is shown again with the fresh list.

import { test } from '@playwright/test';
import { GUARD, MIGRATION } from '../../support/hud.js';
import { fixtures } from '../../support/mock-api.js';
import { panelReport } from '../../support/panel.js';
import { openReview } from '../../support/review.js';
import { marksFromOverlay } from '../../support/review-api.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

/** The touched tier 1 files, in the daemon's order (the Report's `tier1Files`). */
const BOTH = panelReport().summary.tier1Files;
const NEW_HEAD = 'c0ffee12d4b7e6a5c4d3e2f1a0b9c8d7e6f5a4b3';

test('approve/moved/returns-to-unreviewed-on-new-head', async ({ page }, testInfo) => {
  const detail = fixtures.repoMixedChanges();
  const change = detail.changes.find((candidate) => candidate.id === 11);
  if (change === undefined) throw new Error('no change 11 in the fixture');
  await tagClient(page, testInfo.testId);
  const { api } = await openReview(page, {
    api: { details: [detail] },
    marks: marksFromOverlay(panelReport(), { files: { [GUARD]: 'checked', [MIGRATION]: 'checked' } }),
  });
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const reviewTag = page.getByTestId('change-head').locator('.tag.review');

  await page.getByTestId('approve').click();
  await page.getByTestId('approve-confirm').click();
  await expect(page.getByTestId('approved-badge')).toHaveText('Approved 3f2a9c4');
  await expect(reviewTag).toHaveText('Approved');

  // The agent commits again: the daemon's reconcile resets the state (ADR-019) and the guard's mark goes outdated.
  Object.assign(change, { head: NEW_HEAD, reviewState: 'unreviewed', approvedHead: null, approvedAt: null });
  api.review(11).moveSnapshot([GUARD]);
  await emitSse(page, testInfo.testId, 'changes', { repoId: 1 });
  await emitSse(page, testInfo.testId, 'review', { repoId: 1, changeId: 11 });

  await expect(page.getByTestId('approved-badge')).toHaveCount(0);
  await expect(reviewTag).toHaveText('Unreviewed');
  const approve = page.getByTestId('approve');
  await expect(approve).toHaveText('Check the rest and approve');
  await expect(approve).toHaveAttribute('title', /^1 of 2 touched tier 1 files have a current review mark/);
  expect(api.approval(11).writes).toEqual(['POST']);
});

test('approve/moved/check-rest-snapshot-moved-re-shows', async ({ page }) => {
  const { api } = await openReview(page);
  const approve = page.getByTestId('approve');
  await approve.click();
  const dialog = page.getByTestId('check-rest-dialog');
  await expect(dialog.getByTestId('check-rest-file')).toHaveText(BOTH);
  await expect(dialog.getByTestId('check-rest-confirm')).toHaveText('Check 2 files and approve');

  // The change is recomputed behind the open confirmation: the daemon refuses, the list is asked for again and shown with a notice.
  api.review(11).moveSnapshot([]);
  let release = (): void => undefined;
  api.approval(11).holdRemaining = new Promise<void>((resolve) => {
    release = resolve;
  });
  const confirm = dialog.getByTestId('check-rest-confirm');
  await confirm.click();
  // While the fresh list is asked for, the refused one stays busy: a second click sends nothing.
  await expect.poll(() => api.approval(11).remainingReads).toBe(2);
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveText('Approving…');
  await confirm.click({ force: true });
  expect(api.approval(11).bodies).toHaveLength(1);
  api.approval(11).holdRemaining = null;
  release();
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  const notice = dialog.getByTestId('check-rest-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'alert');
  await expect(notice).toContainText('look again before approving');
  await expect.poll(() => api.approval(11).remainingReads).toBe(2);
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('approved-badge')).toHaveCount(0);
  expect(api.approval(11).bodies).toHaveLength(1);
  expect(api.approval(11).bodies[0]).toMatchObject({ snapshotId: 1, files: BOTH });

  // Another tab marks the guard meanwhile: the list the reviewer saw is no longer the one to mark (remaining-changed), shown again.
  const review = api.review(11);
  review.marks = marksFromOverlay(panelReport(), { files: { [GUARD]: 'checked' } });
  await dialog.getByTestId('check-rest-confirm').click();
  await expect.poll(() => api.approval(11).remainingReads).toBe(3);
  await expect(dialog.getByTestId('check-rest-file')).toHaveText([MIGRATION]);
  await expect(dialog.getByTestId('check-rest-confirm')).toHaveText('Check 1 file and approve');
  expect(api.approval(11).bodies[1]).toMatchObject({ snapshotId: 2, files: BOTH });
  await expect(page.getByTestId('approved-badge')).toHaveCount(0);

  // Confirmed on the fresh list: approved.
  await dialog.getByTestId('check-rest-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('approved-badge')).toHaveText('Approved 3f2a9c4');
  expect(api.approval(11).bodies[2]).toMatchObject({ checkRemaining: true, snapshotId: 2, files: [MIGRATION] });
  expect(api.approval(11).writes).toEqual(['POST', 'POST', 'POST']);
});

test('approve/moved/check-rest-other-refusal-shown-in-bar', async ({ page }) => {
  const { api } = await openReview(page);
  await page.getByTestId('approve').click();
  const dialog = page.getByTestId('check-rest-dialog');
  await expect(dialog).toBeVisible();
  // A refusal that is not about the list (the snapshot is being computed): the dialog goes, the reason stays in the bar.
  api.approval(11).failNext = { status: 409, code: 'snapshot-pending', message: 'a newer snapshot is being computed; try again in a moment' };
  await dialog.getByTestId('check-rest-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('approve-error')).toHaveText('a newer snapshot is being computed; try again in a moment');
  await expect(page.getByTestId('approve')).toHaveText('Check the rest and approve');
  await expect(page.getByTestId('approve')).toBeFocused();
  expect(api.approval(11).remainingReads).toBe(1);
});
