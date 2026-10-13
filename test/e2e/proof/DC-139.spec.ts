// Proof video for DC-139 (phase 4): the city's legend never runs into the
// filter rows in the bottom left corner, and it never goes away silently. The
// real daemon from dist/, in a temporary home with a file-size rule in
// settings.json, on the golden order-discounts repo: every filter row is on
// screen, Rules and "Hide checked" included. The window goes 1024x768,
// 1280x800, 1440x900, and the caption shows the measured boxes of the filter
// rows and of the legend. At 1024x600 the legend folds into a "Legend" chip
// whose popover holds it, and the filter rows scroll so every chip stays
// reachable. Recorded by `npm run proof -- DC-139`.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { stubEnv, trackScenario, until } from '../support/change-daemon.js';
import { criterion, expect, HOLD_MS, test, titleCard } from '../support/proof.js';
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

test('DC-139: the legend stays clear of the filter rows, and folds into a chip when there is no room', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-139: the legend and the filters never overlap', [
    'The real daemon from dist/, in a temporary home, on the golden order-discounts repo.',
    'settings.json has a file-size rule (maxLines 20): the Rules row is on screen with "Hide checked".',
    'The window goes 1024x768, 1280x800, 1440x900, then 1024x600.',
  ]);
  await mkdir(proof.home, { recursive: true });
  await writeFile(join(proof.home, 'settings.json'), JSON.stringify({ v: 1, trustedRepos: [], rules: [{ id: 'file-size', kind: 'file-size', maxLines: 20 }] }, null, 2));
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  await until(async () => (await tracked.report()).findings.some((finding) => finding.source === 'rule:file-size') || undefined, 60_000, 'a file-size finding');

  let n = 0;
  for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900]] as const) {
    n += 1;
    await page.setViewportSize({ width, height });
    if (n === 1) {
      await page.goto(tracked.url);
      await waitReady(page);
      await expect(page.getByTestId('filter-hide-checked')).toBeVisible();
      await expect(page.getByRole('group', { name: 'Filter by rule' })).toBeVisible();
    }
    const { filters, legend } = await boxes(page);
    await criterion(page, `${String(n)}. ${String(width)}x${String(height)}: the legend sits under every filter row, Rules included`, async () => {
      expect(legend.y).toBeGreaterThanOrEqual(filters.y + filters.height);
      expect(Math.abs(legend.x - filters.x)).toBeLessThanOrEqual(1);
      await expect(page.getByTestId('legend')).toBeVisible();
      await expect(page.getByTestId('legend-toggle')).toBeHidden();
    }, `filters ${text(filters)} | legend ${text(legend)}`);
  }

  await page.setViewportSize({ width: 1024, height: 600 });
  const toggle = page.getByTestId('legend-toggle');
  await criterion(page, '4. 1024x600: no room for both, so the legend folds into a "Legend" chip; it opens as a popover', async () => {
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId('legend')).toBeHidden();
    await toggle.click();
    await expect(page.getByRole('dialog', { name: 'Legend' })).toBeVisible();
    await expect(page.getByTestId('legend')).toContainText('removed');
  }, 'Esc closes it and gives focus back to the chip');

  await criterion(page, '5. Esc closes the popover; focus is back on the chip', async () => {
    await page.waitForTimeout(HOLD_MS / 2);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('legend')).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  await criterion(page, '6. The filter rows scroll inside the column: the Rules chip and "Hide checked" stay reachable', async () => {
    const rule = page.getByRole('group', { name: 'Filter by rule' }).getByRole('button').first();
    await rule.scrollIntoViewIfNeeded();
    await expect(rule).toBeInViewport();
    await rule.click();
    await expect(rule).toHaveAttribute('aria-pressed', 'true');
    const hide = page.getByTestId('filter-hide-checked');
    await hide.scrollIntoViewIfNeeded();
    await hide.click();
    await expect(hide).toHaveAttribute('aria-pressed', 'true');
  });
});
