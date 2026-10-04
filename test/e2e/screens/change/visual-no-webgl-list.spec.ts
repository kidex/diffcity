// e2e/change/visual-no-webgl-list (SPEC.md section 6): without WebGL the screen
// says the 3D view needs it and lists the touched files with status and
// verdict. Linux CI baseline.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { withoutWebgl } from '../../support/scene.js';
import { linuxOnly, openVisualList, prepareVisual, shot } from '../../support/visual.js';

linuxOnly();
test.describe.configure({ timeout: 60_000 });

test('change/visual-no-webgl-list', async ({ page }) => {
  await prepareVisual(page);
  await withoutWebgl(page);
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openVisualList(page);
  await expect(page).toHaveScreenshot('no-webgl-list.png', shot(page));
});
