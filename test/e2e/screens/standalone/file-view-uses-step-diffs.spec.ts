// e2e/standalone/file-view-uses-step-diffs (ADR-027): with no DiffPort the
// file view falls back to the Report. It shows the diff excerpts of the file's
// steps and says "Full diff is available in the app", with no mount point for
// the full diff and no request for it.

import { SERVICE } from '../../support/hud.js';
import { panelReport } from '../../support/panel.js';
import { project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { recordRequests, test } from '../../support/standalone.js';

test.describe.configure({ timeout: 60_000 });

test('standalone/file-view-uses-step-diffs', async ({ page, standalone }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const urls = recordRequests(page);
  const report = panelReport();
  await standalone.open(report);
  const service = await project(page, SERVICE);
  await page.mouse.click(service.x, service.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);

  const area = page.getByTestId('file-diff');
  await expect(area).toBeVisible();
  // One excerpt per step of the file, each from Step.diff.
  const steps = report.steps.filter((step) => step.fileId === SERVICE);
  expect(steps).toHaveLength(2);
  const excerpts = area.getByTestId('diff-excerpt');
  await expect(excerpts).toHaveCount(steps.length);
  await expect(excerpts.nth(0)).toContainText('OrdersService.place');
  await expect(excerpts.nth(0)).toContainText('const total = this.applyDiscount(order);');
  await expect(excerpts.nth(0)).toContainText('await this.repo.insert(order, total);');
  await expect(excerpts.nth(1)).toContainText('OrdersService.applyDiscount');
  await expect(excerpts.nth(1)).toContainText('return rules.reduce((sum, rule) => rule.apply(sum), order.total);');
  await expect(area.getByTestId('diff-in-app')).toHaveText('Full diff is available in the app');
  await expect(area.getByTestId('diff-mount')).toHaveCount(0);
  // Nothing was asked for: no request to an API of any kind.
  expect(urls.filter((url) => url.includes('/api/'))).toEqual([]);
});
