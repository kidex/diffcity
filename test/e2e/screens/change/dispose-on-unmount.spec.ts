// e2e/change/dispose-on-unmount: leaving the change releases the city. After
// ten round trips between the repo and the change no view is alive, each
// view gave back the same GPU resources before closing its context, and the
// JS heap is back where it was after the first trip. No closed view stays
// reachable either: the number of WebGL contexts left in the heap does not
// grow with the trips (three's shared lookup texture used to keep every
// disposed renderer, and the screen around its canvas, alive: DC-101).

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { disposal, liveContexts, openCity, waitReady, sceneExpect as expect } from '../../support/scene.js';

// A first frame on SwiftShader, plus what each spec does after it, can pass the default 30 s.
test.describe.configure({ timeout: 60_000 });

const ROUND_TRIPS = 10;

test('change/dispose-on-unmount', async ({ page }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  const cdp = await page.context().newCDPSession(page);
  const heap = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  const toRepo = async (): Promise<void> => {
    await page.evaluate(`location.hash = '#/repo/1'`);
    await expect(page.getByTestId('change-row').first()).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  };
  const toChange = async (): Promise<void> => {
    await page.evaluate(`location.hash = '#/change/11'`);
    await waitReady(page);
  };

  // The first trip loads three.js and the fonts; the baseline comes after it.
  await openCity(page);
  await toRepo();
  const first = await disposal(page);
  expect(first.live).toBe(0);
  const baseline = await heap();
  const firstContexts = await liveContexts(cdp);

  for (let i = 0; i < ROUND_TRIPS; i += 1) {
    await toChange();
    expect((await disposal(page)).live).toBe(1);
    await toRepo();
    const after = await disposal(page);
    expect(after.live).toBe(0);
    // Only the renderer's own lookup texture is left when the context closes, the same every time.
    expect(after.lastGeometries).toBe(first.lastGeometries);
    expect(after.lastTextures).toBe(first.lastTextures);
  }
  expect(first.lastGeometries).toBe(0);
  expect(first.lastTextures).toBeLessThanOrEqual(1);
  expect(await liveContexts(cdp)).toBeLessThanOrEqual(firstContexts);
  const end = await heap();
  expect(end - baseline).toBeLessThan(3 * 1024 * 1024);
});
