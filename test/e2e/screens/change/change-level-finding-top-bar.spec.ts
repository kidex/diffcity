// e2e/change/change-level-finding-top-bar (SPEC.md section 4.1: file '' and
// line 0 for a change-level finding): the top bar says "CI failed" when a
// pipeline rule has a change-level finding, and "<n> change-level findings"
// for the others. A Report with none says nothing.

import { expect, test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { changeLevelReport, ciFailedReport, finding, ruleReport } from '../../support/hud.js';
import { sceneExpect, withoutWebgl } from '../../support/scene.js';

test('change/change-level-finding-top-bar', async ({ page }) => {
  await withoutWebgl(page);
  const reports: Record<number, Report> = { 11: ciFailedReport() };
  await mockApi(page, { reports });
  await page.goto('/#/change/11');
  const bar = page.getByTestId('hud-bar');
  // The change screen is a lazily loaded chunk: wait for it to mount after every navigation.
  await sceneExpect(bar).toBeVisible();

  await expect(bar.getByTestId('ci-failed')).toHaveText('CI failed');
  await expect(bar.getByTestId('change-level-findings')).toHaveCount(0);

  reports[11] = changeLevelReport();
  await page.reload();
  await sceneExpect(bar).toBeVisible();
  await expect(bar.getByTestId('change-level-findings')).toHaveText('2 change-level findings');
  await expect(bar.getByTestId('ci-failed')).toHaveCount(0);

  const one = changeLevelReport();
  one.findings = [finding('cl-9', 'claude', '')];
  reports[11] = one;
  await page.reload();
  await sceneExpect(bar).toBeVisible();
  await expect(bar.getByTestId('change-level-findings')).toHaveText('1 change-level finding');

  // A finding on a file is not change-level; neither is a Report without findings.
  reports[11] = ruleReport();
  await page.reload();
  await sceneExpect(bar).toBeVisible();
  await expect(bar.getByTestId('eyes-badge')).toBeVisible();
  await expect(bar.getByTestId('change-level')).toHaveCount(0);
  reports[11] = fixtures.reportGolden();
  await page.reload();
  await sceneExpect(bar).toBeVisible();
  await expect(bar.getByTestId('eyes-badge')).toBeVisible();
  await expect(bar.getByTestId('change-level')).toHaveCount(0);
});
