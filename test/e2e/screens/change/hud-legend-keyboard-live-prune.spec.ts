// e2e/change/hud-legend-keyboard-live-prune (ADR-026, DC-77): the legend names
// the verdicts and statuses; the disabled Export and Approve buttons are
// reachable by keyboard and do nothing; a rule filter whose rule disappears
// from a live update is dropped with the Rules row.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { ruleReport } from '../../support/hud.js';
import { openCity, stats, sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

test('change/hud-legend-keyboard-live-prune', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reports: Record<number, Report> = { 11: ruleReport() };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  const legend = page.getByTestId('legend');
  for (const word of ['added', 'modified', 'signature', 'removed', 'untouched', 'rule violation']) {
    await expect(legend).toContainText(word);
  }

  // Disabled buttons: focusable, aria-disabled, with a title, and inert.
  for (const testId of ['export-plantuml', 'approve']) {
    const button = page.getByTestId(testId);
    await button.focus();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAttribute('title', /\S/);
    await page.keyboard.press('Enter');
  }
  await expect(page).toHaveURL(/#\/change\/11$/);

  // Filter by a rule, then a live update without any rule finding.
  await page.getByRole('group', { name: 'Filter by rule' }).getByRole('button', { name: /^layers/ }).click();
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=;rule=layers');
  const next = fixtures.reportGolden();
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'ccccccc' });
  await expect(page.getByRole('group', { name: 'Filter by rule' })).toHaveCount(0);
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=;rule=');
  await expect(page.getByTestId('legend-rule-x')).toBeHidden();
  expect((await stats(page)).buildings).toBeGreaterThan(0);
});
