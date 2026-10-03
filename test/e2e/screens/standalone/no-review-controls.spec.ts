// e2e/standalone/no-review-controls (ADR-002): the page passes the screen no
// ports, so there is no review UI (no mark buttons, no note, no progress), no
// Fleet card and no live indicator: it is a read-only view of one Report.

import { GUARD } from '../../support/hud.js';
import { panelReport } from '../../support/panel.js';
import { project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { test } from '../../support/standalone.js';

test.describe.configure({ timeout: 60_000 });

test('standalone/no-review-controls', async ({ page, standalone }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await standalone.open(panelReport());
  // Select a building: the file view is where the marks would be.
  const guard = await project(page, GUARD);
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(page.getByTestId('file-view')).toBeVisible();

  const screen = page.locator('.change-body');
  await expect(screen).toBeVisible();
  // No review controls: no working mark button, note field, progress or "hide checked" anywhere.
  // The mockup's disabled placeholders ("Approve when tier 1 is read", "Mark as intended") are
  // drawn with or without ports and do nothing, so only enabled buttons count.
  const review = /^(?:mark\b|needs rewrite|good|looks good|hide checked|copy summary|clear mark|approve)/i;
  await expect(page.getByRole('button', { name: review, disabled: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(?:approve|mark as intended)/i, disabled: true }).first()).toBeDisabled();
  await expect(screen.getByRole('textbox')).toHaveCount(0);
  await expect(screen.getByRole('progressbar')).toHaveCount(0);
  await expect(screen.locator('textarea, input, [data-testid^="mark"], [data-testid^="review"], [data-testid="progress"]')).toHaveCount(0);

  // No Fleet card.
  await expect(page.getByTestId('fleet-card')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Audit status across your projects' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /all \d+ projects/ })).toHaveCount(0);
  expect(await page.evaluate('window.diffcityFleet === undefined')).toBe(true);

  // No live indicator, no SPA shell around the screen.
  await expect(page.getByTestId('daemon')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /live|connected|daemon/i })).toHaveCount(0);
  await expect(page.locator('header.top')).toHaveCount(0);
});
