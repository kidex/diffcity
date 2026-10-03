// e2e/change/no-path-without-steps (ADR-026): a Report without steps draws no
// path: no tube, no rings, no numbers.

import { test } from '@playwright/test';
import { effects } from '../../support/effects.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/no-path-without-steps', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const report = fixtures.reportGolden();
  expect(report.steps).toEqual([]);
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);
  expect((await effects(page)).path).toBeNull();
});
