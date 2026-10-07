// e2e/change/dispose-on-unmount-before-ready: leaving the change before its
// first frame releases the city too. The view uploads three's shared lookup
// texture at mount (the PMREM environment), long before the first frame; a
// view closed during the shader warm-up must not stay reachable through it
// (DC-101). After several such trips the number of WebGL contexts left in the
// heap is no higher than after one full trip.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { disposal, liveContexts, openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

const EARLY_TRIPS = 5;

test('change/dispose-on-unmount-before-ready', async ({ page }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  const cdp = await page.context().newCDPSession(page);
  const toRepo = async (): Promise<void> => {
    await expect(page.getByTestId('change-row').first()).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
  };

  // One full trip first: three.js is loaded and the debug hook holds a view.
  await openCity(page);
  await page.evaluate(`location.hash = '#/repo/1'`);
  await toRepo();
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
    await toRepo();
    expect((await disposal(page)).live).toBe(0);
  }
  expect(await liveContexts(cdp)).toBeLessThanOrEqual(firstContexts);
});
