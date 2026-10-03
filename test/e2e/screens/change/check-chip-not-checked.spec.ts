// e2e/change/check-chip-not-checked (SPEC.md section 6, Rule checks): the top
// bar has one chip per check in the Report; a rule that could not run is shown
// as not checked, with its reason, and never as passed. A Report without
// `checks` shows no chip at all.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { ruleReport, withChecks } from '../../support/hud.js';
import { sceneExpect, withoutWebgl } from '../../support/scene.js';

test('change/check-chip-not-checked', async ({ page }) => {
  await withoutWebgl(page);
  const reports = { 11: ruleReport() };
  withChecks(reports[11], [
    ...((reports[11] as unknown as { checks: never[] }).checks),
    { ruleId: 'lint', kind: 'pipeline', state: 'error', findings: 0, checkedAt: '2026-05-04T11:19:30.000Z' },
    { ruleId: 'tests', kind: 'pipeline', state: 'pending', findings: 0, checkedAt: '2026-05-04T11:19:30.000Z' },
    { ruleId: 'mystery', kind: 'layers', state: 'green', findings: 0, checkedAt: '2026-05-04T11:19:30.000Z' },
  ] as never);
  await mockApi(page, { reports });
  await page.goto('/#/change/11');
  await sceneExpect(page.getByTestId('hud-bar')).toBeVisible();

  const chips = page.getByRole('list', { name: 'Rule checks' }).getByTestId('check-chip');
  await expect(chips).toHaveCount(7);
  const chip = (rule: string) => page.locator(`[data-testid="check-chip"][data-rule="${rule}"]`);

  await expect(chip('deps')).toHaveText('deps: not checked (no network)');
  await expect(chip('deps')).toHaveAttribute('data-state', 'not-checked');
  await expect(chip('deps')).toHaveAttribute('title', 'no network');
  await expect(chip('deps')).not.toContainText('passed');
  await expect(chip('format')).toHaveText('format: passed');
  await expect(chip('layers')).toHaveText('layers: 2 violations');
  await expect(chip('file-size')).toHaveText('file-size: 1 violation');
  await expect(chip('tests')).toHaveText('tests: pending');
  await expect(chip('lint')).toHaveText('lint: could not run');
  // A state the screen does not know is not passed either.
  await expect(chip('mystery')).toHaveAttribute('data-state', 'not-checked');
  await expect(page.locator('[data-testid="check-chip"][data-state="passed"]')).toHaveCount(1);

  // No checks in the Report: no chips.
  reports[11] = fixtures.reportGolden();
  await page.reload();
  await sceneExpect(page.getByTestId('hud-bar')).toBeVisible();
  await expect(page.getByTestId('check-chip')).toHaveCount(0);
  await expect(page.getByTestId('check-chips')).toHaveCount(0);
});
