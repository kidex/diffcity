// e2e/panel/works-without-webgl: without WebGL the change screen renders the
// list of touched files instead of the city, and the reading panel beside it
// (DC-89: the list is the review path without the city). The page stays quiet:
// no console error or page error; J/K select the stops in the list and Esc
// returns from the file view to the tabs; the city's parts (hover sync,
// floors) are simply absent.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { withoutWebgl } from '../../support/scene.js';
import { GUARD, SERVICE } from '../../support/hud.js';
import { panelReport } from '../../support/panel.js';

test('panel/works-without-webgl', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // three.js reports the context it could not create; the screen catches it and falls back.
    if (message.type() === 'error' && !message.text().includes('Error creating WebGL context')) errors.push(message.text());
  });
  await withoutWebgl(page);
  // The review routes answer (a change with no marks), as the daemon's do for a change with a snapshot.
  await mockApi(page, { reports: { 11: panelReport() }, review: {} });
  await page.goto('/#/change/11');

  await expect(page.getByTestId('no-webgl-note')).toHaveText('3D view needs WebGL');
  await expect(page.getByTestId('touched-file').first()).toBeVisible();
  await expect(page.getByTestId('city')).toHaveCount(0);
  await expect(page.getByTestId('reading-panel')).toBeVisible();
  await expect(page.getByTestId('stop-card')).toHaveCount(5);

  // J walks the stops: the list marks the file of the stop and its card is current.
  await page.keyboard.press('j');
  await expect(page.locator('[data-testid="touched-file"].on')).toHaveAttribute('data-path', GUARD);
  await expect(page.getByTestId('stop-card').nth(0)).toHaveClass(/\bon\b/);
  await page.keyboard.press('J');
  await expect(page.locator('[data-testid="touched-file"].on')).toHaveAttribute('data-path', SERVICE);
  await page.keyboard.press('k');
  await expect(page.locator('[data-testid="touched-file"].on')).toHaveAttribute('data-path', GUARD);

  // Esc with no file open is harmless; the list and the panel stay.
  for (const key of ['K', 'Escape', 'j']) await page.keyboard.press(key);
  await expect(page.getByTestId('no-webgl-note')).toBeVisible();
  await expect(page.getByTestId('touched-file').first()).toBeVisible();
  await expect(page.getByTestId('reading-panel')).toBeVisible();
  expect(errors).toEqual([]);
});
