// e2e/panel/esc-returns-to-tabs: Esc closes the file view and clears the
// selection; "Back" closes it and keeps the selection. Either way the tabs
// come back on the tab that was open, scrolled where they were.

import { test } from '@playwright/test';
import { SERVICE } from '../../support/hud.js';
import { selected, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { openPanel, panelReport, scrollTabTo, stopCards, tab, tabOverflow, tabScroll } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/esc-returns-to-tabs', async ({ page }) => {
  // A short window, so the five stops do not fit and the list scrolls.
  await page.setViewportSize({ width: 1280, height: 640 });
  await openPanel(page, panelReport());
  const scroller = page.getByTestId('panel-scroll');
  await expect.poll(() => tabOverflow(page)).toBeGreaterThan(120);
  await scrollTabTo(page, 120);
  await expect.poll(() => tabScroll(page)).toBe(120);

  // A click event, so the list is not scrolled to the card first.
  await stopCards(page).nth(1).dispatchEvent('click');
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  const view = page.getByTestId('file-view');
  await expect(view).toBeVisible();
  await expect(scroller).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
  await expect(tab(page, 'order')).toBeVisible();
  await expect(tab(page, 'order')).toHaveAttribute('aria-pressed', 'true');
  await expect(scroller).toBeVisible();
  expect(await tabScroll(page)).toBe(120);
  await waitForCityAttribute(page, 'data-selected', '');
  await expect(page.getByTestId('selection-card')).toBeHidden();

  // Back: the selection stays, the scroll too.
  await stopCards(page).nth(1).dispatchEvent('click');
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  await expect(view).toBeVisible();
  await page.getByTestId('file-view-back').click();
  await expect(view).toBeHidden();
  expect(await tabScroll(page)).toBe(120);
  expect(await selected(page)).toBe(SERVICE);
  await expect(stopCards(page).nth(1)).toHaveClass(/\bon\b/);
});
