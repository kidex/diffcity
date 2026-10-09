// e2e/session/visual-session-tab (ADR-038): the reading panel's Session tab
// beside the city, from the two-session fixture: the first card with its
// prompts, questions, nested agents (the implementer's run expanded to its
// report and activity) and edited files, the second untitled and out of date.
// Linux CI baseline, like the other visual specs (support/visual.ts).

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { panelReport } from '../../support/panel.js';
import { linuxOnly, openVisualCity, prepareVisual, shot } from '../../support/visual.js';

linuxOnly();
test.describe.configure({ timeout: 120_000 });

test('session/visual-session-tab', async ({ page }) => {
  await prepareVisual(page);
  await mockApi(page, { reports: { 11: panelReport() }, sessions: { 11: fixtures.sessionsTwo() } });
  await openVisualCity(page);
  await page.getByTestId('tab-session').click();
  const run = page.getByTestId('session-run').nth(1);
  await run.getByTestId('run-toggle').click();
  await expect(run.getByTestId('run-report')).toBeVisible();
  // The time range is shown in the browser's time zone: masked, as the breadcrumb's relative time is.
  await expect(page).toHaveScreenshot('session-tab.png', { ...shot(page), mask: [...shot(page).mask, page.getByTestId('session-range')] });
});
