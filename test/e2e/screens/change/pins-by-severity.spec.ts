// e2e/change/pins-by-severity (ADR-026): every finding that is not a rule
// violation is a pin on the roof of its file, one per finding, with its
// severity; rule findings and change-level findings are not pins.

import { test } from '@playwright/test';
import { effects, effectsReport } from '../../support/effects.js';
import { CONTROLLER, GUARD, MIGRATION } from '../../support/hud.js';
import { DTO, MAILER } from '../../support/effects.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/pins-by-severity', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = effectsReport();
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  const { markers } = await effects(page);
  const pins = markers.filter((marker) => marker.kind === 'pin');
  const bySeverity = (severity: string): string[] => pins.filter((pin) => pin.severity === severity).map((pin) => pin.file).sort();
  expect(bySeverity('high')).toEqual([DTO, GUARD, MAILER].sort());
  expect(bySeverity('med')).toEqual([CONTROLLER]);
  expect(bySeverity('low')).toEqual([MIGRATION]);
  // Pins stand on the roof: at the top of their building.
  const shown = await page.evaluate<Record<string, { height: number }>>('window.diffcityScene.shown()');
  for (const pin of pins) expect(pin.y).toBeCloseTo(shown[pin.file]?.height ?? Number.NaN, 5);
  // No pin for the two rule findings on files, none for the change-level one.
  expect(pins).toHaveLength(5);
});
