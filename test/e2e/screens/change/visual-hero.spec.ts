// e2e/change/visual-hero (SPEC.md section 6, Q1): the change screen as the
// reviewer first sees it, from the golden Report: top bar, filters, legend,
// the night city with its roof labels, the reading panel. Linux CI baseline.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { linuxOnly, openVisualCity, prepareVisual, shot } from '../../support/visual.js';

linuxOnly();
test.describe.configure({ timeout: 120_000 });

test('change/visual-hero', async ({ page }) => {
  await prepareVisual(page);
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openVisualCity(page);
  await expect(page).toHaveScreenshot('hero.png', shot(page));
});
