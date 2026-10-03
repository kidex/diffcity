// e2e/fleet/first-paint-responsive (DC-86): under CPU raster (the screens
// project runs Chromium on SwiftShader) the Fleet's first paint of its lots
// must not stall the main thread. A 50 ms heartbeat records the largest gap
// between ticks while the Fleet loads and while a repo appears over SSE.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

const MAX_GAP_MS = 500;
// Runs in the page before anything else: the longest time between two ticks of
// a 50 ms timer, which is how long the main thread was away.
const HEARTBEAT = `
  window.beat = { last: performance.now(), max: 0 };
  setInterval(() => {
    const now = performance.now();
    window.beat.max = Math.max(window.beat.max, now - window.beat.last);
    window.beat.last = now;
  }, 50);
`;

test('the main thread stays responsive while the Fleet paints its lots', async ({ page }, testInfo) => {
  const repos = fixtures.fleetThreeRepos();
  await mockApi(page, { repos });
  await tagClient(page, testInfo.testId);
  await page.addInitScript(HEARTBEAT);
  await page.goto('/#/');
  await expect(page.getByTestId('lot')).toHaveCount(3);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  const added = fixtures.fleetNewRepo();
  repos.unshift(added);
  expect(await emitSse(page, testInfo.testId, 'repo', { repoId: added.id })).toBe(1);
  await expect(page.getByTestId('lot')).toHaveCount(4);
  // Let the frames that paint the new lot run.
  await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  await page.waitForTimeout(300);

  const max = await page.evaluate<number>('window.beat.max');
  testInfo.annotations.push({ type: 'max-heartbeat-gap-ms', description: String(Math.round(max)) });
  console.log(`fleet max heartbeat gap: ${String(Math.round(max))} ms`);
  expect(max).toBeLessThan(MAX_GAP_MS);
});
