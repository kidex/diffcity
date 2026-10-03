// e2e/change/reduced-motion-static (ADR-026): under prefers-reduced-motion
// the critical floors hold a static glow with a halo strip instead of the
// pulse, the path's packets do not move, the tier 1 ring does not breathe,
// and no frame is drawn while nothing changes.

import { test } from '@playwright/test';
import { effects, effectsReport, framesIn } from '../../support/effects.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, stats, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/reduced-motion-static', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: effectsReport() } });
  await openCity(page);

  const state = await effects(page);
  expect(state.mode).toBe('static');
  // The same floors as with motion, now with one halo strip each.
  expect(state.pulsing).toBe(5);
  expect(state.halos).toBe(state.pulsing);
  expect(state.path?.tube).toBe(true);
  expect(state.path?.animated).toBe(false);
  expect(state.tier.ring).toBe(true);
  expect(state.tier.opacity).toBe(1);
  expect(state.continuous).toBe(false);
  expect((await stats(page)).drawCalls).toBeLessThanOrEqual(40);

  // On demand only: once the labels have settled, no frame is drawn while nothing changes.
  await expect
    .poll(() => framesIn(page, 1500), { timeout: 30_000 })
    .toBe(0);
  expect((await effects(page)).tier.opacity).toBe(1);
});
