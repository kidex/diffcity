// e2e/review/two-tabs-sync (ADR-028): two tabs on the same change stay in step.
// The daemon sends SSE `review` after a write; the other tab reads the marks
// again and its city, progress and buttons follow. The tabs share one mock
// daemon here (same review state), each with its own event stream.

import { test } from '@playwright/test';
import { effects } from '../../support/effects.js';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE, panelReport } from '../../support/panel.js';
import { card, expectProgress, openReview, selectFile } from '../../support/review.js';
import type { ReviewMock } from '../../support/review-api.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 120_000 });

test('review/two-tabs-sync', async ({ page, browser, baseURL }, testInfo) => {
  const shared = new Map<number, ReviewMock>();
  const report = panelReport();
  const { api } = await openReview(page, { report, api: { reviewMocks: shared }, wait: false });
  await tagClient(page, `${testInfo.testId}-a`);
  await openCity(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  // The second tab: its own browser context (its own event stream), the same daemon state.
  const other = await browser.newContext({ baseURL: baseURL ?? 'http://127.0.0.1:4507', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    const second = await other.newPage();
    await second.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await mockApi(second, { reports: { 11: report }, reviewMocks: shared });
    await tagClient(second, `${testInfo.testId}-b`);
    await openCity(second);
    await expect(second.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
    await expectProgress(second, '0 of 2 files that need your eyes checked');

    // A mark in the first tab...
    await selectFile(page, GUARD, CAN_PLACE);
    await page.keyboard.press('c');
    await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
    await expect.poll(() => api.review(11).writes.length).toBe(1);

    // ...is not in the second until the daemon says so.
    await second.waitForTimeout(600);
    await expectProgress(second, '0 of 2 files that need your eyes checked');
    const sent = await emitSse(second, `${testInfo.testId}-b`, 'review', { repoId: 1, changeId: 11 });
    expect(sent).toBeGreaterThan(0);

    await expectProgress(second, '1 of 2 files that need your eyes checked');
    await expect.poll(async () => (await effects(second)).checked[GUARD]).toHaveLength(1);
    // The second tab's buttons show it too once the building is selected there.
    await selectFile(second, GUARD, CAN_PLACE);
    await expect(card(second).getByTestId('mark-current')).toHaveText('Checked');

    // And back: an undo in the second tab reaches the first.
    await second.keyboard.press('u');
    await expect(card(second).getByTestId('mark-none')).toHaveText('Not marked');
    await emitSse(page, `${testInfo.testId}-a`, 'review', { repoId: 1, changeId: 11 });
    await expectProgress(page, '0 of 2 files that need your eyes checked');
    await expect(card(page).getByTestId('mark-none')).toHaveText('Not marked');

    // An event for another change does nothing: the first tab does not read the marks again.
    const reads = api.count('/api/changes/11/review');
    await emitSse(page, `${testInfo.testId}-a`, 'review', { repoId: 1, changeId: 99 });
    await page.waitForTimeout(800);
    expect(api.count('/api/changes/11/review')).toBe(reads);
    await emitSse(page, `${testInfo.testId}-a`, 'review', { repoId: 1, changeId: 11 });
    await expect.poll(() => api.count('/api/changes/11/review')).toBe(reads + 1);
  } finally {
    await other.close();
  }
});
