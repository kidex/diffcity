// e2e/review/hidden-without-port (ADR-002): the change screen mounted without a
// ReviewPort has no review controls at all: no mark buttons and no keys, no
// progress, no "Hide checked", no summary, no "Send to agent". Mounted as the SPA does but with the
// review routes refused (the daemon has no snapshot for review), the controls
// stay away too. The standalone page is covered by standalone/no-review-controls.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { openReview, selectFile } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { test as standaloneTest } from '../../support/standalone.js';
import { panelReport } from '../../support/panel.js';

test.describe.configure({ timeout: 90_000 });

const NO_REVIEW = '[data-testid^="mark-"], [data-testid="progress"], [data-testid="filter-hide-checked"], [data-testid="review-summary"], [data-testid="send-to-agent"], [data-testid="card-review"]:not([hidden])';

test('review/hidden-without-port: no snapshot to review, no controls and the keys do nothing', async ({ page }) => {
  // The review routes answer 409 no-snapshot: the port is there, there is nothing to mark.
  const { api } = await openReview(page, { wait: false });
  await page.route('**/api/changes/11/review**', (route) => route.fulfill({ status: 409, json: { error: { code: 'no-snapshot', message: 'no snapshot yet' } } }));
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  await selectFile(page, GUARD, CAN_PLACE);
  await expect(page.getByTestId('file-view')).toBeVisible();
  await expect(page.locator(NO_REVIEW)).toHaveCount(0);
  await page.keyboard.press('c');
  await page.keyboard.press('w');
  await expect(page.getByTestId('rewrite-dialog')).toHaveCount(0);
  expect(api.review(11).writes).toEqual([]);
});

standaloneTest('review/hidden-without-port: the standalone page has none of it', async ({ page, standalone }) => {
  await standalone.open(panelReport());
  await selectFile(page, GUARD, CAN_PLACE);
  await expect(page.locator(NO_REVIEW)).toHaveCount(0);
  await page.keyboard.press('c');
  await page.keyboard.press('g');
  await expect(page.getByTestId('rewrite-dialog')).toHaveCount(0);
  await expect(page.getByTestId('filter-hide-checked')).toHaveCount(0);
  // The filter rows are still there; without an ApprovalPort there is no Approve (DC-116).
  await expect(page.getByTestId('filter-clear')).toBeVisible();
  await expect(page.getByTestId('approve')).toHaveCount(0);
});
