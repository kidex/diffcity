// perf/quality-probe-picks-once (ADR-026, DC-90): the quality level is chosen
// once at mount, from a 500 ms probe of the real frame rate, and never changes
// while the screen is in use: not with the camera moving, a live update, a
// resize or a bench. Under SwiftShader the frames are slow, so the probe picks
// a fallback level, a GPU the full one; the spec asserts the level is the one the measured frame
// rate maps to, that its settings are those of the ladder (MSAA, bloom scale,
// environment map), and that the budgets of the scene still hold. One large
// city for the file.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { levelFor, QUALITY_LEVELS } from '../../../../src/ui/screens/change/scene/quality.js';
import { openLargeCity, type LargeCity } from '../../support/large-city.js';
import { bench, quality, stats, sceneExpect as expect } from '../../support/scene.js';

let city: LargeCity;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  city = await openLargeCity(browser, testInfo, 'reduce');
});
test.afterAll(async () => {
  await city.close();
});

test('perf/quality-probe-picks-once', async () => {
  test.setTimeout(240_000);
  const { page } = city;
  await expect.poll(async () => (await quality(page)).settled, { timeout: 120_000 }).toBe(true);
  const chosen = await quality(page);
  expect(chosen.probes).toBe(1);
  expect(chosen.fps).not.toBeNull();
  // The level is what the measured median maps to, with the ladder's settings.
  expect(chosen).toMatchObject({ ...levelFor(chosen.fps ?? 0) });
  expect(QUALITY_LEVELS[chosen.level]).toMatchObject({ msaa: chosen.msaa, bloomScale: chosen.bloomScale, environment: chosen.environment });
  // Whatever the renderer's speed: one completed probe and a level of the ladder.
  expect(chosen.level).toBeGreaterThanOrEqual(0);
  expect(chosen.level).toBeLessThanOrEqual(3);

  // Using the screen never probes again, and never changes the level.
  const canvas = await page.getByTestId('city-canvas').boundingBox();
  if (canvas === null) throw new Error('no canvas');
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2 + 80, canvas.y + canvas.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await page.mouse.wheel(0, -120);
  await page.setViewportSize({ width: 1200, height: 800 });
  await bench(page, 800);
  const next: Report = structuredClone(city.report);
  next.packages[0]?.files.reverse();
  await city.push(next);
  await expect.poll(async () => (await stats(page)).frames).toBeGreaterThan(0);
  await bench(page, 500);

  const later = await quality(page);
  expect(later).toEqual(chosen);
  // The budgets hold at the level it picked.
  expect((await stats(page)).drawCalls).toBeLessThanOrEqual(40);
  expect((await stats(page)).triangles).toBeLessThanOrEqual(1_500_000);
});
