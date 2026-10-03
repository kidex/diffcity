// e2e/change/tooltip-fields (mockup .tip, SPEC.md section 6): hovering a
// building shows its verdict, file, package, counts by status, the floor under
// the cursor and the number of findings, plus the rule violations when there
// are any; leaving the building hides it.

import { test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { GUARD, SERVICE, finding, ruleReport } from '../../support/hud.js';
import { openCity, project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/tooltip-fields', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = ruleReport();
  report.findings.push(finding('claude-2', 'semgrep', GUARD, { title: 'Second finding on the guard' }));
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);
  const tip = page.getByTestId('tooltip');
  await expect(tip).not.toHaveClass(/show/);

  // The guard: eyes, tier 1 package, two findings, none of them a rule violation.
  const guard = await project(page, GUARD);
  await page.mouse.move(guard.x, guard.y, { steps: 3 });
  await waitForCityAttribute(page, 'data-hovered', GUARD);
  await expect(tip).toHaveClass(/show/);
  await expect(tip.getByTestId('tip-verdict')).toHaveText('Needs your eyes');
  await expect(tip.getByTestId('tip-file')).toHaveText('order.guard.ts');
  await expect(tip.getByTestId('tip-package')).toHaveText('src/auth');
  await expect(tip.getByTestId('tip-counts')).toHaveText('+0 added0 modified1 sig0 removed');
  await expect(tip.getByTestId('tip-floor')).toHaveText(/^floor: (OrderGuard|OrderGuard\.canRead|OrderGuard\.canPlace)$/);
  await expect(tip.getByTestId('tip-findings')).toHaveText('2 findings');
  await expect(tip.getByTestId('tip-violations')).toHaveCount(0);

  // The service: a rule violation among its findings.
  const service = await project(page, SERVICE);
  await page.mouse.move(service.x, service.y, { steps: 3 });
  await waitForCityAttribute(page, 'data-hovered', SERVICE);
  await expect(tip.getByTestId('tip-file')).toHaveText('orders.service.ts');
  await expect(tip.getByTestId('tip-package')).toHaveText('src/services/orders');
  await expect(tip.getByTestId('tip-verdict')).toHaveText('Reviewed, fine');
  await expect(tip.getByTestId('tip-findings')).toHaveText('1 finding');
  await expect(tip.getByTestId('tip-violations')).toHaveText('1 rule violation');

  // Off the building, it goes.
  const canvas = await page.getByTestId('city-canvas').boundingBox();
  if (canvas === null) throw new Error('no canvas');
  await page.mouse.move(canvas.x + 30, canvas.y + canvas.height - 30);
  await waitForCityAttribute(page, 'data-hovered', '');
  await expect(tip).not.toHaveClass(/show/);
});
