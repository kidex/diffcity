// e2e/panel/empty-steps-state: a Report without steps shows the empty state in
// the Execution order tab, with a zero counter, and the city has no path.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { noStepsReport, openPanel, stopCards, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/empty-steps-state', async ({ page }) => {
  await openPanel(page, noStepsReport());
  await expect(page.getByTestId('empty-steps')).toHaveText('The reading path arrives with the execution path');
  await expect(stopCards(page)).toHaveCount(0);
  await expect(tab(page, 'order')).toHaveText('Execution order0');
  // The other tabs still work without steps.
  await tab(page, 'symbols').click();
  await expect(page.getByTestId('symbol-group').first()).toBeVisible();
  await expect(page.getByTestId('panel-summary')).toHaveText('No execution path for this change yet');
});
