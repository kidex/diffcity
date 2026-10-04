// e2e/change/live-update-agent-writes (SPEC.md section 9, section 3a C4, phase
// 3 exit criterion 2): the real daemon from dist/ has the order-discounts
// change open on screen, with a file selected, a type filter set and the file
// view open. An agent writes to the working tree (a new function in
// orders.service.ts): within 8 s the city has one more floor, with no reload.
// Camera, selection, filters and the open file view stay, and the other
// buildings keep their place on screen (under half a pixel).
//
// The service file already has more than six symbols, so its footprint does
// not grow with the new floor and nothing but its own height changes. Motion
// is reduced: the city takes the new Report in one step, which is what the
// drift is measured against. The arrival time and the largest drift are
// attached to the test.

import type { Page } from '@playwright/test';
import { appendFunction, SERVICE, stubEnv, trackScenario, until } from '../support/change-daemon.js';
import { expect, test } from '../support/proof.js';
import { camera, project, selected, selectedFloor, stats, waitForCityAttribute, waitReady, type CameraState } from '../support/scene.js';

/** The agent's edit must show up in the city within this long. */
const ARRIVAL_MS = 8000;
/** Existing buildings may not move more than this on screen. */
const DRIFT_PX = 0.5;

const NEW_FUNCTION = 'applyLoyaltyBonus';

test('change/live-update-agent-writes', async ({ proof, page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  const report = await tracked.report();
  const files = report.packages.flatMap((pkg) => pkg.files).map((file) => file.id);

  await page.goto(tracked.url);
  await waitReady(page);

  // A file selected, its file view open and a type filter set.
  const point = await project(page, SERVICE);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  await expect(page.getByTestId('file-view')).toBeVisible();
  await page.getByTestId('filter-type-add').click();
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=add;rule=');
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-state', 'text');
  await expect(page.getByTestId('diff-view')).not.toContainText(NEW_FUNCTION);

  // The state to keep. `window.__kept` goes with the document: a reload drops it.
  await page.evaluate('window.__kept = performance.now()');
  const before = {
    camera: await camera(page),
    selected: await selected(page),
    floor: await selectedFloor(page),
    stats: await stats(page),
    points: await pointsOf(page, files),
  };

  // The agent writes. t0 is when the write landed on disk.
  await appendFunction(tracked.repo, SERVICE, NEW_FUNCTION);
  const t0 = Date.now();
  const apiAt = until(async () => ((await tracked.report()).packages.flatMap((pkg) => pkg.files).find((file) => file.id === SERVICE)?.symbols.some((symbol) => symbol.name === NEW_FUNCTION) === true ? Date.now() - t0 : undefined), 20_000, 'the report with the new function').catch(() => -1);
  await page.waitForFunction(`window.diffcityScene.stats().floors === ${String(before.stats.floors + 1)}`, null, { timeout: ARRIVAL_MS, polling: 50 });
  const arrivedMs = Date.now() - t0;
  const apiMs = await apiAt;
  expect(arrivedMs).toBeLessThan(ARRIVAL_MS);

  // No reload: the page's own marker is still there and no navigation happened.
  expect(await page.evaluate<number | undefined>('window.__kept')).toBeDefined();
  const after = {
    camera: await camera(page),
    selected: await selected(page),
    floor: await selectedFloor(page),
    stats: await stats(page),
    points: await pointsOf(page, files),
  };
  expect(after.stats.floors).toBe(before.stats.floors + 1);
  expect(after.stats.buildings).toBe(before.stats.buildings);

  // Camera, selection, filters and the file view are kept.
  expectSameCamera(after.camera, before.camera);
  expect(after.selected).toBe(SERVICE);
  expect(after.floor).toBe(before.floor);
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=add;rule=');
  await expect(page.getByTestId('file-view')).toBeVisible();
  await expect(page.getByTestId('file-view-file')).toHaveText(SERVICE);
  // The file view follows the new snapshot: the diff names the new function.
  await expect(page.getByTestId('diff-view')).toContainText(NEW_FUNCTION, { timeout: ARRIVAL_MS });

  // Every other building stays where it was, to the sub-pixel.
  let drift = 0;
  let drifting = '';
  for (const file of files) {
    if (file === SERVICE) continue;
    const was = before.points.get(file);
    const now = after.points.get(file);
    if (was === undefined || now === undefined) continue;
    const moved = Math.hypot(now.x - was.x, now.y - was.y);
    if (moved > drift) {
      drift = moved;
      drifting = file;
    }
  }
  expect(drift, `${drifting} moved ${drift.toFixed(3)} px`).toBeLessThan(DRIFT_PX);
  expect(before.points.size).toBeGreaterThan(10);

  await test.info().attach('live-update-timing', {
    body: `the daemon's report had the new function ${String(apiMs)} ms after the write\nthe new floor was on screen ${String(arrivedMs)} ms after the write (limit ${String(ARRIVAL_MS)} ms)\nlargest drift of the other ${String(before.points.size - 1)} buildings: ${drift.toFixed(4)} px (${drifting}, limit ${String(DRIFT_PX)} px)\n`,
    contentType: 'text/plain',
  });
  console.log(`live update: report in ${String(apiMs)} ms, floor in ${String(arrivedMs)} ms, drift ${drift.toFixed(4)} px over ${String(before.points.size - 1)} buildings`);
});

/** Client point of every building that is on screen. */
async function pointsOf(page: Page, files: string[]): Promise<Map<string, { x: number; y: number }>> {
  const points = new Map<string, { x: number; y: number }>();
  for (const file of files) {
    const point = await project(page, file).catch(() => null);
    if (point !== null) points.set(file, point);
  }
  return points;
}

function expectSameCamera(now: CameraState, was: CameraState): void {
  expect(now.theta).toBeCloseTo(was.theta, 6);
  expect(now.phi).toBeCloseTo(was.phi, 6);
  expect(now.r).toBeCloseTo(was.r, 6);
}
