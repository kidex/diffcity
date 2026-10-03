// e2e/change/markers-open-only (PO decision 2026-10-03): pins and X markers
// are drawn for open findings only; a fixed or intended finding draws none,
// and the Rules row counters and the rule filter count the same findings, so
// the city and the HUD agree.

import { test } from '@playwright/test';
import { effects, effectsReport } from '../../support/effects.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/markers-open-only', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = effectsReport();
  for (const item of report.findings) {
    if (item.id === 'pin-med' || item.id === 'rule-roof') item.state = 'fixed';
    if (item.id === 'pin-low' || item.id === 'rule-floor') item.state = 'intended';
  }
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  const { markers } = await effects(page);
  // 8 findings: one is change-level, four are closed; three pins are open (guard, dto, mailer), no rule X.
  expect(markers.filter((marker) => marker.kind === 'x')).toHaveLength(0);
  expect(markers.filter((marker) => marker.kind === 'pin').map((marker) => marker.severity)).toEqual(['high', 'high', 'high']);
  // No open rule finding on a file: no Rules row.
  await expect(page.getByRole('group', { name: 'Filter by rule' })).toHaveCount(0);
});
