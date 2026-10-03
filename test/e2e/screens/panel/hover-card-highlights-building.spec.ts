// e2e/panel/hover-card-highlights-building: hovering a stop card (or focusing
// it with the keyboard) lights its building in the city; leaving puts it out.

import { test } from '@playwright/test';
import { GUARD, SERVICE } from '../../support/hud.js';
import { hovered, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { openPanel, stopCards } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/hover-card-highlights-building', async ({ page }) => {
  await openPanel(page);
  const cards = stopCards(page);
  await cards.nth(1).hover();
  await waitForCityAttribute(page, 'data-hovered', SERVICE);
  expect(await hovered(page)).toBe(SERVICE);
  // Another card moves the highlight.
  await cards.nth(0).hover();
  await waitForCityAttribute(page, 'data-hovered', GUARD);
  // Leaving the panel puts it out.
  await page.getByTestId('city-canvas').hover({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await page.getByTestId('city').getAttribute('data-hovered')) ?? '').toBe('');
  // The keyboard lights it too.
  await cards.nth(1).focus();
  await waitForCityAttribute(page, 'data-hovered', SERVICE);
  await page.getByTestId('tab-findings').focus();
  await expect.poll(async () => (await page.getByTestId('city').getAttribute('data-hovered')) ?? '').toBe('');
  // A hover does not select.
  await expect(page.getByTestId('city')).toHaveAttribute('data-selected', '');
});
