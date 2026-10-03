// e2e/change/hostile-text-is-inert (ADR-026, DC-77): file paths, package paths
// and finding texts come from repositories. The HUD sets them with textContent,
// so markup in them is shown as text and never becomes an element or runs.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { GUARD, finding } from '../../support/hud.js';
import { openCity, project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

const PATH = 'src/auth/<img src=x onerror="window.__pwned=1">.ts';
const TITLE = '<script>window.__pwned=2</script>Guard <b>bold</b>';

test('change/hostile-text-is-inert', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = fixtures.reportGolden();
  const guard = report.packages.flatMap((pkg) => pkg.files).find((file) => file.id === GUARD);
  if (guard === undefined) throw new Error('guard missing');
  guard.path = PATH;
  report.findings = [finding('evil-1', 'claude', GUARD, { title: TITLE, message: '<img src=y onerror="window.__pwned=3">' })];
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  const point = await project(page, GUARD);
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await waitForCityAttribute(page, 'data-hovered', GUARD);
  await expect(page.getByTestId('tooltip')).toContainText('<img src=x onerror=');

  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  const card = page.getByTestId('selection-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('<img src=x onerror=');

  const hud = page.getByTestId('hud');
  await expect(hud.locator('img, script, [onerror]')).toHaveCount(0);
  expect(await page.evaluate('window.__pwned')).toBeUndefined();
});
