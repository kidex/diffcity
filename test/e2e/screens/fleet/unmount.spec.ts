// e2e/fleet/unmount: leaving the Fleet stops its refetches, including the
// trailing one the 250 ms coalescer still holds for a burst of SSE events.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

test('a refetch pending at unmount never runs', async ({ page }, testInfo) => {
  const api = await mockApi(page);
  await tagClient(page, testInfo.testId);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('lot')).toHaveCount(3);
  // Let the start-up refetches (mount, hello) settle.
  await page.waitForTimeout(400);

  // Two events: the first refetches at once, the second waits for the 250 ms
  // window. Leave the Fleet as soon as the first refetch goes out.
  const before = api.count('/api/repos');
  const first = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/repos');
  await emitSse(page, testInfo.testId, 'repo', { repoId: 1 });
  await emitSse(page, testInfo.testId, 'repo', { repoId: 2 });
  await first;
  await page.evaluate(`location.hash = '#/repo/1'`);

  await expect(page.locator('[data-screen="repo"]')).toBeVisible();
  await page.waitForTimeout(600);
  // Only the first refetch of the burst ran; the trailing one was dropped.
  expect(api.count('/api/repos')).toBe(before + 1);
});
