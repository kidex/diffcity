// e2e/change/draw-call-budget (ADR-026): the scene stays within 40 draw calls
// whatever the size of the change, on the golden Report and on 2,000 files.
// The frame rate from the bench is recorded as an annotation (SwiftShader
// here, so it says little about a real GPU).

import { test } from '@playwright/test';
import { effects, marksFor, withEveryEffect } from '../../support/effects.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { marksFromOverlay } from '../../support/review-api.js';
import { bench, openCity, stats, sceneExpect as expect } from '../../support/scene.js';

// A first frame on SwiftShader, plus what each spec does after it, can pass the default 30 s.
test.describe.configure({ timeout: 60_000 });

const BUDGET = 40;

for (const [name, report] of [
  ['golden', fixtures.reportGolden],
  ['2,000 files', fixtures.reportLargeCity],
] as const) {
  test(`change/draw-call-budget: ${name}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const data = report();
    await mockApi(page, { reports: { 11: data } });
    await openCity(page);
    const files = data.packages.reduce((sum, pkg) => sum + pkg.files.length, 0);
    const scene = await stats(page);
    expect(scene.buildings).toBe(files);
    expect(scene.drawCalls).toBeGreaterThan(0);
    expect(scene.drawCalls).toBeLessThanOrEqual(BUDGET);
    expect(scene.labels).toBeLessThanOrEqual(120);

    const measured = await bench(page, 1500);
    expect(measured.drawCalls).toBeLessThanOrEqual(BUDGET);
    testInfo.annotations.push({ type: 'bench', description: `${name}: ${String(measured.drawCalls)} draw calls, ${String(measured.fps)} fps` });
  });
}

// Every effect on: pulse (or its static glow and halo), beams, pins, rule X
// markers, check and rewrite markers, the reading path with its rings and
// numbers, and the tier 1 ring, in both motion modes.
for (const [name, report] of [
  ['golden', fixtures.reportGolden],
  ['2,000 files', fixtures.reportLargeCity],
] as const) {
  for (const motion of ['no-preference', 'reduce'] as const) {
    test(`change/draw-call-budget: ${name} with every effect on, motion ${motion}`, async ({ page }, testInfo) => {
      test.setTimeout(150_000);
      await page.emulateMedia({ reducedMotion: motion });
      const data = withEveryEffect(report());
      await mockApi(page, { reports: { 11: data }, review: { marks: marksFromOverlay(data, marksFor(data)) } });
      await openCity(page);

      const shown = await effects(page);
      // Every effect is really on.
      expect(shown.pulsing).toBeGreaterThan(0);
      expect(shown.halos).toBe(motion === 'reduce' ? shown.pulsing : 0);
      expect(shown.path?.tube).toBe(true);
      expect(shown.tier.ring).toBe(true);
      const kinds = new Set(shown.markers.map((marker) => marker.kind));
      expect([...kinds].sort()).toEqual(['check', 'notch', 'pin', 'rewrite', 'x']);

      const scene = await stats(page);
      expect(scene.drawCalls).toBeGreaterThan(0);
      expect(scene.drawCalls).toBeLessThanOrEqual(BUDGET);
      const measured = await bench(page, 1500);
      expect(measured.drawCalls).toBeLessThanOrEqual(BUDGET);
      testInfo.annotations.push({ type: 'bench', description: `${name}, motion ${motion}: ${String(measured.drawCalls)} draw calls, ${String(measured.fps)} fps` });
    });
  }
}
