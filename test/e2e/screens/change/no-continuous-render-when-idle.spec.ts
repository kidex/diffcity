// e2e/change/no-continuous-render-when-idle (ADR-026): the loop renders
// continuously only while something animates (pulse, packets, tier 1
// breathing), the tab is visible and reduced motion is off. A calm change, a
// hidden tab and reduced motion each leave it on demand: no frame is drawn
// while nothing changes.

import { test } from '@playwright/test';
import { calmReport, effects, effectsReport, framesIn, setTabVisible } from '../../support/effects.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 120_000 });

/** No frame in a window, once the labels have settled after the last change. */
const idle = (page: Parameters<typeof framesIn>[0]) => expect.poll(() => framesIn(page, 1500), { timeout: 30_000 }).toBe(0);

test('change/no-continuous-render-when-idle: a calm change renders on demand', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockApi(page, { reports: { 11: calmReport() } });
  await openCity(page);
  const state = await effects(page);
  expect(state.pulsing).toBe(0);
  expect(state.tier.ring).toBe(false);
  expect(state.path).toBeNull();
  expect(state.continuous).toBe(false);
  await idle(page);
});

test('change/no-continuous-render-when-idle: it runs while something animates, stops with a hidden tab and starts again', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockApi(page, { reports: { 11: effectsReport() } });
  await openCity(page);
  expect((await effects(page)).continuous).toBe(true);
  expect(await framesIn(page, 3000)).toBeGreaterThanOrEqual(2);

  await setTabVisible(page, false);
  expect((await effects(page)).continuous).toBe(false);
  await idle(page);

  await setTabVisible(page, true);
  expect((await effects(page)).continuous).toBe(true);
  await expect.poll(() => framesIn(page, 2000), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
});

test('change/no-continuous-render-when-idle: reduced motion renders on demand', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: effectsReport() } });
  await openCity(page);
  expect((await effects(page)).continuous).toBe(false);
  await idle(page);
});
