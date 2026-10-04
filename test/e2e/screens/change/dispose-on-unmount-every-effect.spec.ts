// e2e/change/dispose-on-unmount-every-effect: the change -> repo -> change
// round trip on data with every effect on (path with steps and rings,
// findings, a rule X, checked and rewrite marks, the halo under reduced
// motion). Each view gives back every geometry and texture it made: what is
// left when the context closes is the same on every trip.

import { test } from '@playwright/test';
import { effects, marksFor, withEveryEffect } from '../../support/effects.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { marksFromOverlay } from '../../support/review-api.js';
import { disposal, openCity, waitReady, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 120_000 });

const ROUND_TRIPS = 4;

for (const motion of ['reduce', 'no-preference'] as const) {
  test(`change/dispose-on-unmount-every-effect: motion ${motion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    const data = withEveryEffect(fixtures.reportGolden());
    await mockApi(page, { reports: { 11: data }, review: { marks: marksFromOverlay(data, marksFor(data)) } });

    const toRepo = async (): Promise<void> => {
      await page.evaluate(`location.hash = '#/repo/1'`);
      await expect(page.getByTestId('change-row').first()).toBeVisible();
      await expect(page.locator('canvas')).toHaveCount(0);
    };
    const everyEffectOn = async (): Promise<void> => {
      const shown = await effects(page);
      expect(shown.pulsing).toBeGreaterThan(0);
      expect(shown.halos).toBe(motion === 'reduce' ? shown.pulsing : 0);
      expect(shown.path?.tube).toBe(true);
      expect(shown.tier.ring).toBe(true);
      const kinds = new Set(shown.markers.map((marker) => marker.kind));
      expect([...kinds].sort()).toEqual(['check', 'notch', 'pin', 'rewrite', 'x']);
    };

    await openCity(page);
    await everyEffectOn();
    await toRepo();
    const first = await disposal(page);
    expect(first.live).toBe(0);
    // Nothing the effects made is left: no geometry, at most the renderer's own lookup texture.
    expect(first.lastGeometries).toBe(0);
    expect(first.lastTextures).toBeLessThanOrEqual(1);

    for (let i = 0; i < ROUND_TRIPS; i += 1) {
      await page.evaluate(`location.hash = '#/change/11'`);
      await waitReady(page);
      await everyEffectOn();
      expect((await disposal(page)).live).toBe(1);
      await toRepo();
      const after = await disposal(page);
      expect(after.live).toBe(0);
      expect(after.lastGeometries).toBe(first.lastGeometries);
      expect(after.lastTextures).toBe(first.lastTextures);
    }
  });
}
