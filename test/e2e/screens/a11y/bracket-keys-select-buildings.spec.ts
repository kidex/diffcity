// e2e/a11y/bracket-keys-select-buildings (DC-89): `]` and `[` select the next
// and previous touched building in the Report's order, the only keyboard path
// to buildings besides the stops J and K walk. They stop at the ends (as N and
// J do), never pick an untouched building, leave the floor unfocused, and
// J and K keep walking the stops.

import { test } from '@playwright/test';
import { GUARD, SERVICE } from '../../support/hud.js';
import { openPanel, panelReport } from '../../support/panel.js';
import { selected, selectedFloor, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('a11y/bracket-keys-select-buildings', async ({ page }) => {
  const report = panelReport();
  const touched = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same').map((file) => file.id);
  expect(touched.length).toBeGreaterThan(3);
  expect(report.packages.flatMap((pkg) => pkg.files).some((file) => file.status === 'same')).toBe(true);
  await openPanel(page, report);

  // Nothing selected: ] goes to the first touched building, in the Report's order.
  await page.keyboard.press(']');
  await expect.poll(() => selected(page)).toBe(touched[0]);
  expect(await selectedFloor(page)).toBeNull();
  for (let i = 1; i < touched.length; i += 1) {
    await page.keyboard.press(']');
    await expect.poll(() => selected(page)).toBe(touched[i]);
  }
  // Never past the last one.
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  await expect.poll(() => selected(page)).toBe(touched[touched.length - 1]);

  // Back down to the first, and no further.
  for (let i = touched.length - 2; i >= 0; i -= 1) {
    await page.keyboard.press('[');
    await expect.poll(() => selected(page)).toBe(touched[i]);
  }
  await page.keyboard.press('[');
  await expect.poll(() => selected(page)).toBe(touched[0]);

  // The panel follows: the card of the selection is shown and the stop of the guard is current.
  await expect(page.getByTestId('card-file')).toHaveText(touched[0] ?? '');
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toBeNull();

  // [ with nothing selected also starts at the first one.
  await page.keyboard.press('[');
  await expect.poll(() => selected(page)).toBe(touched[0]);
  // J and K are the stops': from nothing, J goes to the first stop.
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toBeNull();
  await page.keyboard.press('j');
  await expect.poll(() => selected(page)).toBe(GUARD);
  await page.keyboard.press('j');
  await expect.poll(() => selected(page)).toBe(SERVICE);
  expect(await selectedFloor(page)).not.toBeNull();
  // ] from a floor of the service goes to the next building after the service in the Report's order.
  await page.keyboard.press(']');
  const after = touched[touched.indexOf(SERVICE) + 1] ?? SERVICE;
  await expect.poll(() => selected(page)).toBe(after);
  expect(await selectedFloor(page)).toBeNull();
});
