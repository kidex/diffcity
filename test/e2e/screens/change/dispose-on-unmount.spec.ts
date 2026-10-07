// e2e/change/dispose-on-unmount: leaving the change releases the city. After
// ten round trips between the repo and the change no view is alive, each
// view gave back the same GPU resources before closing its context, and the
// JS heap is back where it was after the first trip. No closed view stays
// reachable either: the number of WebGL contexts left in the heap does not
// grow with the trips (three's shared lookup texture used to keep every
// disposed renderer, and the screen around its canvas, alive: DC-101).
//
// Leaving the change before its first frame releases the city too. The view
// uploads three's shared lookup texture at mount (the PMREM environment), long
// before the first frame; a view closed during the shader warm-up must not
// stay reachable through it (DC-101). After several such trips the number of
// WebGL contexts left in the heap is no higher than after one full trip.

import { test, type CDPSession, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { disposal, liveContexts, openCity, waitReady, sceneExpect as expect } from '../../support/scene.js';

// A first frame on SwiftShader, plus what each spec does after it, can pass the default 30 s.
test.describe.configure({ timeout: 60_000 });

const ROUND_TRIPS = 10;
const EARLY_TRIPS = 5;

interface Trips {
  cdp: CDPSession;
  toRepo: () => Promise<void>;
  toChange: () => Promise<void>;
}

/** Mocks the API, makes the first full trip (it loads three.js and the fonts) and ends on the repo. */
async function firstTrip(page: Page): Promise<Trips> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  const cdp = await page.context().newCDPSession(page);
  const toRepo = async (): Promise<void> => {
    await page.evaluate(`location.hash = '#/repo/1'`);
    await expect(page.getByTestId('change-row').first()).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  };
  const toChange = async (): Promise<void> => {
    await page.evaluate(`location.hash = '#/change/11'`);
    await waitReady(page);
  };
  await openCity(page);
  await toRepo();
  return { cdp, toRepo, toChange };
}

test('change/dispose-on-unmount', async ({ page }) => {
  test.setTimeout(180_000);
  const { cdp, toRepo, toChange } = await firstTrip(page);
  const heap = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };

  // The baseline comes after the first trip.
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

test('change/dispose-on-unmount: left before the first frame', async ({ page }) => {
  test.setTimeout(180_000);
  const { cdp } = await firstTrip(page);
  // The debug hook holds the view of the full trip.
  const firstContexts = await liveContexts(cdp);

  for (let i = 0; i < EARLY_TRIPS; i += 1) {
    // Leaves as soon as the canvas is in the page: the view is mounted, its
    // environment uploaded, its shaders still warming up.
    const readyWhenLeaving = await page.evaluate<string | null>(`new Promise((resolve) => {
      const leave = (canvas) => {
        observer.disconnect();
        const ready = canvas.closest('[data-testid="city"]').getAttribute('data-ready');
        location.hash = '#/repo/1';
        resolve(ready);
      };
      const observer = new MutationObserver(() => {
        const canvas = document.querySelector('[data-testid="city-canvas"]');
        if (canvas !== null) leave(canvas);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      location.hash = '#/change/11';
    })`);
    expect(readyWhenLeaving).not.toBe('true');
    await expect(page.getByTestId('change-row').first()).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    expect((await disposal(page)).live).toBe(0);
  }
  expect(await liveContexts(cdp)).toBeLessThanOrEqual(firstContexts);
});
