// e2e/change/checked-rendering (ADR-026, DC-50, ADR-028): review marks change
// what is drawn. The ReviewPort is wired in a later task, so the page hands the
// scene a fake overlay through the `?scene-debug` hook (window.diffcityMarks).
// A marked floor stops pulsing and its strip drops to 0.35x with the glass at
// 0.6; a checked file gets a check mark on the roof (so does one whose changed floors are all checked); "needs rewrite" gets a
// notch on the floor and a plate on the roof; an outdated mark looks unchecked.

import { test } from '@playwright/test';
import { DTO, effects, effectsReport, floorIndex, openWithMarks, symbolId } from '../../support/effects.js';
import { GUARD, MIGRATION, SERVICE } from '../../support/hud.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/checked-rendering', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const report = effectsReport();
  const calcTotal = floorIndex(report, SERVICE, 'OrdersService.calcTotal');
  await mockApi(page, { reports: { 11: report } });
  await openWithMarks(page, {
    // The whole migration is looked over: no pulse, a check mark on its roof, a half-strength outline.
    files: { [MIGRATION]: 'good' },
    symbols: {
      // The guard's critical floor is checked: it stops pulsing.
      [symbolId(report, GUARD, 'OrderGuard.canPlace')]: 'checked',
      // A floor marked for rewrite: a notch on its face, a plate on the roof.
      [symbolId(report, SERVICE, 'OrdersService.calcTotal')]: 'rewrite',
      // An outdated mark looks unchecked: the floor still pulses.
      [symbolId(report, DTO, 'CreateOrderDto.from')]: 'outdated',
    },
  });
  await openCity(page);

  const state = await effects(page);
  expect(state.pulse[MIGRATION]).toBeUndefined();
  expect(state.pulse[GUARD]).toBeUndefined();
  expect(state.pulse[DTO]?.floors).toEqual([floorIndex(report, DTO, 'CreateOrderDto.from')]);

  // Marked floors: strip 0.35x, and they count as checked. The whole migration inherits its file's mark.
  expect(state.checked[MIGRATION]).toEqual([0, 1]);
  expect(state.checked[GUARD]).toEqual([floorIndex(report, GUARD, 'OrderGuard.canPlace')]);
  expect(state.checked[SERVICE]).toEqual([calcTotal]);
  expect(state.checked[DTO]).toBeUndefined();
  expect(state.gains[MIGRATION]?.every((entry) => entry.gain === 0.35)).toBe(true);

  const kinds = (kind: string): string[] => state.markers.filter((marker) => marker.kind === kind).map((marker) => marker.file);
  // Fully checked files: the migration (its file mark) and the guard (its only changed floor is checked).
  expect(kinds('check').sort()).toEqual([GUARD, MIGRATION].sort());
  expect(kinds('rewrite')).toEqual([SERVICE]);
  const notches = state.markers.filter((marker) => marker.kind === 'notch');
  expect(notches.map((notch) => [notch.file, notch.floor])).toEqual([[SERVICE, calcTotal]]);
  // The check mark is above the roof, the notch is on the floor's face.
  const shown = await page.evaluate<Record<string, { height: number }>>('window.diffcityScene.shown()');
  const check = state.markers.find((marker) => marker.kind === 'check');
  expect(check?.y).toBeGreaterThan(shown[MIGRATION]?.height ?? Number.POSITIVE_INFINITY);
});
