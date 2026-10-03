// e2e/change/rule-x-on-roof (ADR-026, DC-52): a rule finding with no symbol
// is drawn as an X on the roof of its file.

import { test } from '@playwright/test';
import { effects, effectsReport, FLOOR_STEP, floorCount } from '../../support/effects.js';
import { REPO } from '../../support/hud.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/rule-x-on-roof', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = effectsReport();
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  const { markers } = await effects(page);
  const onRoof = markers.filter((marker) => marker.kind === 'x' && marker.floor === null);
  expect(onRoof).toHaveLength(1);
  const [cross] = onRoof;
  const roof = floorCount(report, REPO) * FLOOR_STEP - (FLOOR_STEP - 0.5);
  expect(cross?.file).toBe(REPO);
  expect(cross?.severity).toBe('med');
  // Lying on the roof, just above it.
  expect(cross?.y).toBeGreaterThan(roof);
  expect(cross?.y).toBeLessThan(roof + 0.1);
});
