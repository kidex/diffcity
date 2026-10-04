// e2e/change/visual-file-view (SPEC.md section 6, Q1): a click on the guard
// building opens the file view over the panel: header, stops, and the full
// diff with highlighting, hunks and the hunk bar. Linux CI baseline.

import { expect, test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { serveGuard } from '../../support/fileview.js';
import { mockApi } from '../../support/mock-api.js';
import { panelReport } from '../../support/panel.js';
import { project, waitForCityAttribute } from '../../support/scene.js';
import { linuxOnly, openVisualCity, prepareVisual, settle, shot } from '../../support/visual.js';

linuxOnly();
test.describe.configure({ timeout: 120_000 });

/** A spot over the panel's header, away from every building and button. */
const VISUAL_PARK = { x: 1300, y: 330 };

test('change/visual-file-view', async ({ page }) => {
  await prepareVisual(page);
  await mockApi(page, { reports: { 11: panelReport() }, diff: serveGuard() });
  await openVisualCity(page);
  const point = await project(page, GUARD);
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-state', 'text');
  await expect(page.getByTestId('diff-row').first()).toBeVisible();
  // The pointer leaves the city: no tooltip over the selection card.
  await page.mouse.move(VISUAL_PARK.x, VISUAL_PARK.y);
  await settle(page);
  await expect(page).toHaveScreenshot('file-view.png', shot(page));
});
