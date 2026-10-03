// e2e/change/pulse-on-critical-floors (ADR-026, DC-50): the floors of eyes
// and risky files, of tier 1 files and with an open high finding pulse, each
// building on its own phase; a high finding with no symbol pulses the roof
// strip; nothing else does. The loop renders continuously while they pulse,
// and the tier 1 ring breathes. Read through the scene's `effects()` hook.

import { test } from '@playwright/test';
import { DTO, effects, effectsReport, floorCount, floorIndex, framesIn, MAILER } from '../../support/effects.js';
import { GUARD, MIGRATION, SERVICE } from '../../support/hud.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, stats, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/pulse-on-critical-floors', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const report = effectsReport();
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  const state = await effects(page);
  expect(state.mode).toBe('animated');
  // Eyes: both floors of the migration, the changed floor of the guard (its high finding is on that floor too).
  expect(state.pulse[MIGRATION]?.floors).toEqual([0, 1]);
  expect(state.pulse[GUARD]?.floors).toEqual([floorIndex(report, GUARD, 'OrderGuard.canPlace')]);
  // An ok file pulses for an open high finding on its floor (an unchanged one here), and on its roof strip (the top floor's) when the finding has no symbol.
  expect(state.pulse[DTO]?.floors).toEqual([floorIndex(report, DTO, 'CreateOrderDto.from')]);
  expect(state.pulse[MAILER]?.floors).toEqual([floorCount(report, MAILER) - 1]);
  // Nothing else: ok files with lower findings stay quiet, unchanged files too.
  expect(Object.keys(state.pulse).sort()).toEqual([DTO, GUARD, MAILER, MIGRATION].sort());
  expect(state.pulse[SERVICE]).toBeUndefined();
  expect(state.pulsing).toBe(2 + 1 + 1 + 1);
  expect(state.halos).toBe(0);

  // Each building has its own phase.
  const phases = Object.values(state.pulse).map((entry) => entry.phase.toFixed(4));
  expect(new Set(phases).size).toBe(phases.length);

  // A pulsing strip takes the full gain, even on a floor that did not change (the DTO's), which is quiet otherwise.
  expect(state.gains[DTO]).toEqual([{ floor: floorIndex(report, DTO, 'CreateOrderDto.from'), gain: 1.9 }]);

  // The loop runs on its own while they pulse, and the tier 1 ring breathes.
  expect(state.continuous).toBe(true);
  expect(state.tier.ring).toBe(true);
  expect(await framesIn(page, 3000)).toBeGreaterThanOrEqual(2);
  const opacities = new Set<number>();
  for (let i = 0; i < 6; i += 1) {
    opacities.add((await effects(page)).tier.opacity);
    await page.waitForTimeout(400);
  }
  expect(opacities.size).toBeGreaterThan(1);
  for (const opacity of opacities) {
    expect(opacity).toBeGreaterThanOrEqual(0.3);
    expect(opacity).toBeLessThanOrEqual(1);
  }
  expect((await stats(page)).drawCalls).toBeLessThanOrEqual(40);
});
