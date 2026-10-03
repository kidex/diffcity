// e2e/change/intro-skipped-reduced-motion: the camera eases in from afar on
// open (46/30 of the home distance, as in the mockup), except under
// prefers-reduced-motion, where the first frame is already the home view.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { camera, firstCamera, openCity, type CameraState, sceneExpect as expect } from '../../support/scene.js';

// A first frame on SwiftShader, plus what each spec does after it, can pass the default 30 s.
test.describe.configure({ timeout: 60_000 });

const isHome = async (page: Parameters<typeof camera>[0], state: CameraState): Promise<void> => {
  await page.keyboard.press('r');
  expect(await camera(page)).toEqual(state);
};

test('change/intro-skipped-reduced-motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);
  const first = await firstCamera(page);
  expect(await camera(page)).toEqual(first);
  await isHome(page, first);
});

test('change/intro-skipped-reduced-motion: without the preference the intro runs and lands home', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);
  const first = await firstCamera(page);
  // The intro lasts 1.4 s; under SwiftShader a frame can take longer, so wait for it to land.
  await expect
    .poll(async () => {
      const a = await camera(page);
      await page.waitForTimeout(300);
      return (await camera(page)).r === a.r && a.r < first.r;
    }, { timeout: 20_000 })
    .toBe(true);
  const landed = await camera(page);
  expect(first.r).toBeCloseTo((landed.r * 46) / 30, 5);
  expect([first.theta, first.phi]).toEqual([landed.theta, landed.phi]);
  await isHome(page, landed);
});
