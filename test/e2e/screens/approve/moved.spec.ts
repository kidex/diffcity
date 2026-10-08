// e2e/approve/moved (DC-116, ADR-019, ADR-036): an approved change whose head
// moves is reset to unreviewed by the daemon. The UI computes none of it: on
// SSE `changes` and `review` the route refetches the change and the marks, the
// badge goes, and Approve closes again because the mark on the tier 1 file
// that changed went outdated.

import { test } from '@playwright/test';
import { GUARD, MIGRATION } from '../../support/hud.js';
import { fixtures } from '../../support/mock-api.js';
import { panelReport } from '../../support/panel.js';
import { openReview } from '../../support/review.js';
import { marksFromOverlay } from '../../support/review-api.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

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
  await expect(approve).toHaveText('Approve when tier 1 is read');
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  await expect(approve).toHaveAttribute('title', '1 of 2 touched tier 1 files have a current review mark');
  expect(api.approval(11).writes).toEqual(['POST']);
});
