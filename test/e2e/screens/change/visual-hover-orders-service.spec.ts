// e2e/change/visual-hover-orders-service (SPEC.md section 6, Q1): the pointer
// over orders.service.ts lifts its building, outlines it twice as strong and
// shows the tooltip. Linux CI baseline.

import { expect, test } from '@playwright/test';
import { SERVICE } from '../../support/hud.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { project, waitForCityAttribute } from '../../support/scene.js';
import { linuxOnly, openVisualCity, prepareVisual, settle, shot } from '../../support/visual.js';

linuxOnly();
test.describe.configure({ timeout: 120_000 });

test('change/visual-hover-orders-service', async ({ page }) => {
  await prepareVisual(page);
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openVisualCity(page);
  const point = await project(page, SERVICE);
  await page.mouse.move(point.x, point.y, { steps: 6 });
  await waitForCityAttribute(page, 'data-hovered', SERVICE);
  await expect(page.getByRole('tooltip')).toContainText('orders.service.ts');
  await settle(page);
  await expect(page).toHaveScreenshot('hover-orders-service.png', shot(page));
});
