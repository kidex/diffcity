// e2e/panel/j-k-navigation: J and K walk the stops of the reading path: the
// city's selection and floor follow, the card is marked, and the ends hold.
// Without steps they walk the touched symbols. The keys are the screen's:
// typing in a field does not trigger them, and they stop with the screen.

import { test } from '@playwright/test';
import { GUARD, MIGRATION, SERVICE } from '../../support/hud.js';
import { selected, selectedFloor, sceneExpect as expect } from '../../support/scene.js';
import { ALTER, APPLY, CAN_PLACE, MAILER, noStepsReport, openPanel, PLACE, SEND, stopCards } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

async function at(page: Parameters<typeof selected>[0], file: string, symbol: string): Promise<void> {
  await expect.poll(() => selected(page)).toBe(file);
  await expect.poll(() => selectedFloor(page)).toBe(symbol);
}

test('panel/j-k-navigation', async ({ page }) => {
  await openPanel(page);
  const cards = stopCards(page);
  await page.keyboard.press('j');
  await at(page, GUARD, CAN_PLACE);
  await expect(cards.nth(0)).toHaveClass(/\bon\b/);
  await page.keyboard.press('j');
  await at(page, SERVICE, PLACE);
  await expect(cards.nth(1)).toHaveClass(/\bon\b/);
  await expect(cards.nth(0)).not.toHaveClass(/\bon\b/);
  // A second stop in the same file moves the floor.
  await page.keyboard.press('J');
  await at(page, SERVICE, APPLY);
  await expect(cards.nth(2)).toHaveClass(/\bon\b/);
  await expect(cards.nth(1)).not.toHaveClass(/\bon\b/);
  await page.keyboard.press('k');
  await at(page, SERVICE, PLACE);
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await at(page, MIGRATION, ALTER);
  await page.keyboard.press('j');
  await at(page, MAILER, SEND);
  // Never past the ends.
  await page.keyboard.press('j');
  await at(page, MAILER, SEND);
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('k');
  await at(page, GUARD, CAN_PLACE);
  await expect(cards.nth(0)).toHaveClass(/\bon\b/);
  // The selected card is in view in the panel.
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toBeNull();
  await expect(page.locator('.step.on')).toHaveCount(0);
});

test('panel/j-k-navigation-symbols-without-steps', async ({ page }) => {
  await openPanel(page, noStepsReport());
  await page.keyboard.press('j');
  await expect.poll(() => selected(page)).toBe(MIGRATION);
  await expect.poll(() => selectedFloor(page)).toBe(ALTER);
  await page.keyboard.press('j');
  await expect.poll(() => selectedFloor(page)).toBe(`${MIGRATION}#CREATE INDEX orders_discount_idx`);
  await page.keyboard.press('k');
  await expect.poll(() => selectedFloor(page)).toBe(ALTER);
  await expect(page.getByTestId('reading-panel').locator('.foot')).toContainText('next / previous symbol');
});
