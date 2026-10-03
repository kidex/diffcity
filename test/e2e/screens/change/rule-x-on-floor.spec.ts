// e2e/change/rule-x-on-floor (ADR-026, DC-52): a finding whose source starts
// with `rule:` is drawn as an X, not a pin, on the floor of its symbol; a
// change-level finding gets no marker at all.

import { test } from '@playwright/test';
import { effects, effectsReport, FLOOR_H, FLOOR_STEP, floorIndex } from '../../support/effects.js';
import { SERVICE } from '../../support/hud.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/rule-x-on-floor', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = effectsReport();
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  const { markers } = await effects(page);
  const onFloor = markers.filter((marker) => marker.kind === 'x' && marker.floor !== null);
  expect(onFloor).toHaveLength(1);
  const [cross] = onFloor;
  const floor = floorIndex(report, SERVICE, 'OrdersService.calcTotal');
  expect(cross?.file).toBe(SERVICE);
  expect(cross?.floor).toBe(floor);
  expect(cross?.severity).toBe('low');
  // It stands at the middle of that floor's slab, not on the roof.
  expect(cross?.y).toBeCloseTo(floor * FLOOR_STEP + FLOOR_H / 2, 5);
  // It is not also a pin, and the change-level rule finding drew nothing: 8 findings, 7 with a file.
  expect(markers.filter((marker) => marker.kind === 'pin')).toHaveLength(5);
  expect(markers.filter((marker) => marker.kind === 'x')).toHaveLength(2);
  expect(report.findings).toHaveLength(8);
});
