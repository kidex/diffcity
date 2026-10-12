// e2e/review/checked-floor-stops-pulsing (SPEC.md section 6, "3D city";
// ADR-026, ADR-028): a critical floor pulses until the reviewer marks it; the
// mark, whichever of the three, stops the pulse and undo brings it back. Marking
// goes through the ReviewPort, not a debug input.

import { test } from '@playwright/test';
import { effects, floorIndex } from '../../support/effects.js';
import { GUARD, SERVICE } from '../../support/hud.js';
import { APPLY, CAN_PLACE } from '../../support/panel.js';
import { cardButton, openReview, selectFile } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/checked-floor-stops-pulsing', async ({ page }) => {
  const { report } = await openReview(page, { motion: 'no-preference' });
  const canPlace = floorIndex(report, GUARD, 'OrderGuard.canPlace');

  // The guard is a tier 1 file that needs eyes: its changed floor pulses.
  const before = await effects(page);
  expect(before.pulse[GUARD]?.floors).toEqual([canPlace]);
  expect(before.pulse[SERVICE]).toBeUndefined();
  expect(before.checked[GUARD]).toBeUndefined();

  await selectFile(page, GUARD, CAN_PLACE);
  await page.keyboard.press('c');
  await expect.poll(async () => (await effects(page)).pulse[GUARD]).toBeUndefined();
  expect((await effects(page)).checked[GUARD]).toEqual([canPlace]);

  // Undo: it pulses again and is drawn unchecked.
  await cardButton(page, 'undo').click();
  await expect.poll(async () => (await effects(page)).pulse[GUARD]?.floors).toEqual([canPlace]);
  expect((await effects(page)).checked[GUARD]).toBeUndefined();

  // Needs rewrite also stops it, at once and without a note: the floor has been looked at, and is drawn as a rewrite.
  await cardButton(page, 'rewrite').click();
  await expect.poll(async () => (await effects(page)).pulse[GUARD]).toBeUndefined();
  expect((await effects(page)).markers.some((marker) => marker.kind === 'notch' && marker.file === GUARD)).toBe(true);

  // A floor that never pulsed is unaffected by marking another file's floor.
  await selectFile(page, SERVICE, APPLY);
  await page.keyboard.press('g');
  await expect.poll(async () => (await effects(page)).checked[SERVICE]).toEqual([floorIndex(report, SERVICE, 'OrdersService.applyDiscount')]);
  expect((await effects(page)).pulse[GUARD]).toBeUndefined();
});
