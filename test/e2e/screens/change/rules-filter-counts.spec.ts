// e2e/change/rules-filter-counts (ADR-026, DC-52): the Rules row has one chip
// per rule that has findings, with its count, and dims the buildings with no
// finding of the chosen rule. It is hidden when the Report has no rule
// findings, and so is the legend's X entry.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { CONTROLLER, REPO, SERVICE, paintDump, ruleReport } from '../../support/hud.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/rules-filter-counts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = ruleReport();
  await mockApi(page, { reports: { 11: report, 13: fixtures.reportGolden() } });
  await openCity(page);

  const row = page.getByRole('group', { name: 'Filter by rule' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button')).toHaveCount(2);
  const layers = row.getByRole('button', { name: /^layers/ });
  const fileSize = row.getByRole('button', { name: /^file-size/ });
  await expect(layers).toHaveText('layers2');
  await expect(fileSize).toHaveText('file-size1');
  await expect(page.getByTestId('legend-rule-x')).toBeVisible();
  await expect(page.getByTestId('legend-rule-x')).toHaveText('×rule violation');

  await layers.click();
  await expect(layers).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=;rule=layers');
  const files = report.packages.flatMap((pkg) => pkg.files).map((file) => file.id);
  const dimmed = (await paintDump(page)).dimmed;
  expect(dimmed.sort()).toEqual(files.filter((id) => id !== REPO && id !== CONTROLLER).sort());
  // The labels of the two matching buildings stay lit.
  await expect(page.locator(`[data-building="${REPO}"]`)).not.toHaveClass(/is-dim/);

  await fileSize.click();
  await expect(layers).toHaveAttribute('aria-pressed', 'false');
  expect((await paintDump(page)).dimmed.sort()).toEqual(files.filter((id) => id !== SERVICE).sort());

  // A Report without rule findings has no Rules row and no X in the legend (a live update here, so the filter on goes with it).
  await page.getByRole('button', { name: 'Show everything' }).click();
  await page.evaluate("location.hash = '#/change/13'");
  await expect(page.getByRole('group', { name: 'Filter by verdict' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Filter by rule' })).toHaveCount(0);
  await expect(page.getByTestId('legend-rule-x')).toBeHidden();
});
