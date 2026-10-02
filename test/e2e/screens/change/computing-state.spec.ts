// e2e/change/computing-state: a change with its head but no snapshot yet
// says it is computing; the city appears on SSE `snapshot`, in the screen
// already mounted.

import { expect, test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';
import { stats, waitReady } from '../../support/scene.js';

test('change/computing-state', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reports: Record<number, Report> = {};
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await page.goto('/?scene-debug#/change/11');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('report-computing')).toHaveText('Computing the first snapshot of this change…');
  await expect(page.getByTestId('city')).toHaveCount(0);

  reports[11] = fixtures.reportGolden();
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });
  await waitReady(page);
  await expect(page.getByTestId('report-computing')).toHaveCount(0);
  expect((await stats(page)).buildings).toBe(17);
});

test('change/computing-state: a PR whose head is not fetched says so, not computing', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/change/12');
  await expect(page.getByTestId('head-not-fetched')).toHaveText('head not fetched locally');
  await expect(page.getByTestId('report-computing')).toHaveCount(0);
  await expect(page.getByTestId('city')).toHaveCount(0);
});
