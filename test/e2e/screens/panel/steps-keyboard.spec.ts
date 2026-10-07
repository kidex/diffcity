// e2e/panel/steps-keyboard (DC-105): J and K walk the steps of the golden
// change across the sections, from the execution path into the migrations
// and on into Unconnected, the city selecting each one; Enter on a card opens
// its file view with the focus on Back, and Esc returns to the tabs, the
// sections in place and the focus back on the card. One page load for the file.

import type { Page } from '@playwright/test';
import { test } from '@playwright/test';
import type { Report, Step } from '../../../../src/core/report/types.js';
import { fixtures } from '../../support/mock-api.js';
import { selected, selectedFloor, sceneExpect as expect } from '../../support/scene.js';
import { cardOf, openPanel, stepsOf, stopSection, stopSections, tab } from '../../support/panel.js';

test.describe.configure({ mode: 'serial', timeout: 90_000 });

let page: Page;
const report: Report = fixtures.reportWithSteps();
const path = stepsOf(report, 'path');
const migrations = stepsOf(report, 'migration');
const unconnected = stepsOf(report, 'unconnected');

async function at(one: Step | undefined, section: NonNullable<Step['section']>): Promise<void> {
  if (one === undefined) throw new Error('step missing');
  await expect.poll(() => selectedFloor(page)).toBe(one.symbolId);
  expect(await selected(page)).toBe(one.fileId);
  await expect(cardOf(page, one)).toHaveClass(/\bon\b/);
  await expect(stopSection(page, section).locator('.step.on')).toHaveCount(1);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openPanel(page, report);
});
test.afterAll(async () => {
  await page.close();
});

test('panel/steps-keyboard/jk-walks-steps-across-sections', async () => {
  await page.keyboard.press('j');
  await at(path[0], 'path');
  for (let i = 1; i < path.length; i += 1) await page.keyboard.press('j');
  await at(path.at(-1), 'path');
  // Past the path's last step: the first migration.
  await page.keyboard.press('j');
  await at(migrations[0], 'migration');
  await expect(stopSection(page, 'path').locator('.step.on')).toHaveCount(0);
  await page.keyboard.press('J');
  await at(migrations[1], 'migration');
  // Past the last migration: the first unconnected symbol.
  await page.keyboard.press('j');
  await at(unconnected[0], 'unconnected');
  await expect(stopSection(page, 'migration').locator('.step.on')).toHaveCount(0);
  // And back.
  await page.keyboard.press('k');
  await at(migrations[1], 'migration');
  await page.keyboard.press('K');
  await page.keyboard.press('k');
  await at(path.at(-1), 'path');
  // The ends hold.
  for (let i = 0; i < report.steps.length; i += 1) await page.keyboard.press('j');
  await at(unconnected.at(-1), 'unconnected');
});

test('panel/steps-keyboard/esc-returns-to-tabs', async () => {
  const one = unconnected[2];
  if (one === undefined) throw new Error('step missing');
  const card = cardOf(page, one);
  await card.focus();
  await page.keyboard.press('Enter');
  const view = page.getByTestId('file-view');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('file-view-file')).toHaveText(one.fileId);
  await expect(page.getByTestId('file-view-back')).toBeFocused();
  await expect.poll(() => selectedFloor(page)).toBe(one.symbolId);

  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
  await expect(tab(page, 'order')).toHaveAttribute('aria-pressed', 'true');
  await expect(stopSections(page)).toHaveCount(3);
  await expect(card).toBeFocused();
  await expect.poll(() => selected(page)).toBeNull();
  // The walk goes on from the keyboard: J from nothing is the first step.
  await page.keyboard.press('j');
  await at(path[0], 'path');
});
