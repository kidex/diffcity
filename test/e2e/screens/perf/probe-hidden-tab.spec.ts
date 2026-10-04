// perf/probe-hidden-tab-restarts (ADR-026, DC-90): a tab hidden while the
// quality probe runs voids it (a hidden tab draws no frames, which would read
// as a slow GPU and pick the lowest level for good). The probe starts over
// when the tab is visible again, completes once, and the level is the one its
// measured frame rate maps to.
//
// The tab's visibility is emulated: `document.visibilityState` is overridden by
// an init script that a test flips (with a `visibilitychange` event), the same
// signal the stage listens to. The hook exposes `fps`, `settled` and `probes`,
// so the spec asserts: nothing settles while hidden, exactly one probe
// completes after the tab is shown, and the level equals `levelFor(fps)`.

import { test } from '@playwright/test';
import { levelFor, QUALITY_LEVELS } from '../../../../src/ui/screens/change/scene/quality.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { openCity, quality, sceneExpect as expect } from '../../support/scene.js';
import { tagClient } from '../../support/sse.js';

test('perf/probe-hidden-tab-restarts', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const baseURL = testInfo.project.use.baseURL;
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.addInitScript(`{
      let state = 'hidden';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
      window.__setVisibility = (next) => { state = next; document.dispatchEvent(new Event('visibilitychange')); };
    }`);
    await mockApi(page, { reports: { 11: fixtures.reportLargeCity() } });
    await tagClient(page, testInfo.testId);
    // Mounted while hidden: the probe waits.
    await openCity(page);
    expect(await quality(page)).toMatchObject({ settled: false, probes: 0, fps: null });

    // Shown, then hidden again while the probe runs: voided, and it does not settle.
    await page.evaluate('window.__setVisibility("visible")');
    await page.waitForTimeout(400);
    await page.evaluate('window.__setVisibility("hidden")');
    await page.waitForTimeout(3000);
    expect(await quality(page)).toMatchObject({ settled: false, probes: 0, fps: null });

    // Shown for good: the probe restarts, completes once.
    await page.evaluate('window.__setVisibility("visible")');
    await expect.poll(async () => (await quality(page)).settled, { timeout: 120_000 }).toBe(true);
    const chosen = await quality(page);
    expect(chosen.probes).toBe(1);
    expect(chosen.fps).not.toBeNull();
    // The level is what the visible window's median maps to, not a starved probe's level 3
    // (a probe that ran hidden would report 0 fps; here the level follows whatever fps was measured).
    expect(chosen).toMatchObject({ ...levelFor(chosen.fps ?? 0) });
    expect(QUALITY_LEVELS[chosen.level]).toMatchObject({ msaa: chosen.msaa, bloomScale: chosen.bloomScale, environment: chosen.environment });

    // Hiding and showing again after it is settled changes nothing.
    await page.evaluate('window.__setVisibility("hidden")');
    await page.waitForTimeout(1000);
    await page.evaluate('window.__setVisibility("visible")');
    await page.waitForTimeout(1500);
    expect(await quality(page)).toEqual(chosen);
  } finally {
    await context.close();
  }
});
