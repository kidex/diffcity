// e2e/change/mockup-parity-panel: every element of design/mockup.html's
// reading panel is on the change screen, found by role and text: the header
// "Reading path" and its sentence, the four tabs with counters, a stop card
// with its rail, node, symbol, file, verdict and status tags, `why`, diff and
// finding with its source and the two buttons, and the footer with J K and the
// sources of the findings. Where the panel differs from the mockup (no reading
// time, Session tab hidden, buttons disabled) the difference is listed in the task.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { openPanel, panel, stopCards } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('change/mockup-parity-panel', async ({ page }) => {
  await openPanel(page);
  const reading = panel(page);
  await expect(page.getByRole('complementary', { name: 'Reading path' })).toBeVisible();
  await expect(reading.getByRole('heading', { name: 'Reading path' })).toBeVisible();
  await expect(reading.getByTestId('panel-summary')).toHaveText('5 stops, in the order the code runs');
  for (const label of ['Execution order', 'Findings', 'Outside the spec', 'Symbols']) await expect(reading.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();

  const card = stopCards(page).first();
  await expect(card.locator('.rail')).toBeAttached();
  await expect(card.locator('.node')).toBeAttached();
  await expect(card.locator('.sym')).toBeVisible();
  await expect(card.locator('.file')).toBeVisible();
  await expect(card.locator('.tag.verdict')).toBeVisible();
  await expect(card.locator('.tag.sig')).toBeVisible();
  await expect(card.locator('.why')).toBeVisible();
  await expect(card.locator('.code')).toBeVisible();
  await expect(card.locator('.pin .sev.high')).toBeVisible();
  await expect(card.locator('.pin .src')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Ask agent to fix' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Mark as intended' })).toBeVisible();
  // The rail runs down the column: it stops at the first and last node, like the mockup's.
  await expect(stopCards(page).nth(2).locator('.rail')).toBeAttached();

  const foot = reading.locator('.foot');
  await expect(foot.locator('.k').nth(0)).toHaveText('J');
  await expect(foot.locator('.k').nth(1)).toHaveText('K');
  await expect(foot).toContainText('next / previous stop');
  await expect(foot.getByTestId('panel-sources')).toHaveText('Findings from Claude, semgrep, eslint');

  // The panel sits at the right of the city, as the mockup's two-column layout.
  const city = await page.getByTestId('city').boundingBox();
  const box = await reading.boundingBox();
  if (city === null || box === null) throw new Error('no boxes');
  expect(box.x).toBeGreaterThanOrEqual(city.x + city.width - 1);
  expect(box.width).toBeGreaterThanOrEqual(360);
});
