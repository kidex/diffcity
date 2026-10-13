// Proof video for DC-139 (phase 4): the city's legend never runs into the
// filter rows in the bottom left corner. The real daemon from dist/, in a
// temporary home, on the golden order-discounts repo; the window goes from
// 1024x768 to 1280x800 and 1440x900, and the caption shows the measured boxes
// of the filter rows ("Hide checked" with them) and of the legend. At 1024x700
// the city is too short for both: the legend gives way instead of covering
// the filters. Recorded by `npm run proof -- DC-139`.

import type { Page } from '@playwright/test';
import { stubEnv, trackScenario } from '../support/change-daemon.js';
import { criterion, expect, test, titleCard } from '../support/proof.js';
import { waitReady } from '../support/scene.js';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const text = (box: Box): string => `x${String(Math.round(box.x))} y${String(Math.round(box.y))} ${String(Math.round(box.width))}x${String(Math.round(box.height))}`;

async function boxes(page: Page): Promise<{ filters: Box; legend: Box }> {
  const [filters, legend] = await Promise.all([page.getByTestId('hud-filters').boundingBox(), page.getByTestId('legend').boundingBox()]);
  if (filters === null || legend === null) throw new Error('no box for the filters or the legend');
  return { filters, legend };
}

test('DC-139: the legend stays clear of the filter rows at every window size', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-139: the legend and the filters never overlap', [
    'The real daemon from dist/, in a temporary home, on the golden order-discounts repo.',
    'The window goes 1024x768, 1280x800, 1440x900, then 1024x700.',
    'Each step shows the measured boxes of the filter rows and of the legend.',
  ]);
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');

  let n = 0;
  for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900]] as const) {
    n += 1;
    await page.setViewportSize({ width, height });
    if (n === 1) {
      await page.goto(tracked.url);
      await waitReady(page);
      await expect(page.getByTestId('filter-hide-checked')).toBeVisible();
    }
    const { filters, legend } = await boxes(page);
    await criterion(page, `${String(n)}. ${String(width)}x${String(height)}: the legend sits under the filters, "Hide checked" included`, async () => {
      expect(legend.y).toBeGreaterThanOrEqual(filters.y + filters.height);
      expect(Math.abs(legend.x - filters.x)).toBeLessThanOrEqual(1);
      await expect(page.getByTestId('legend')).toBeVisible();
    }, `filters ${text(filters)} | legend ${text(legend)}`);
  }

  await page.setViewportSize({ width: 1024, height: 700 });
  const { filters, legend } = await boxes(page);
  await criterion(page, '4. 1024x700: too short for both, the legend gives way and the filters stay whole', async () => {
    const overlap = legend.x < filters.x + filters.width && filters.x < legend.x + legend.width && legend.y < filters.y + filters.height && filters.y < legend.y + legend.height;
    expect(overlap).toBe(false);
    await expect(page.getByTestId('filter-clear')).toBeVisible();
  }, `filters ${text(filters)} | legend moved out of the column: ${text(legend)}`);
});
