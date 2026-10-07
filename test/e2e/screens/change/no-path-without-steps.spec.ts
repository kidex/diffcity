// e2e/change/no-path-without-steps (ADR-026): a Report without steps draws no
// path: no tube, no rings, no numbers; the reading panel says there is no
// execution path, with no section heading (DC-105).

import { test } from '@playwright/test';
import { effects } from '../../support/effects.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/no-path-without-steps', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // The golden carries an execution path since DC-97: strip it.
  const report = { ...fixtures.reportGolden(), steps: [] };
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);
  expect((await effects(page)).path).toBeNull();
  await expect(page.getByTestId('empty-steps')).toHaveText('No execution path: nothing in this change reaches an entry point');
  await expect(page.getByTestId('section-heading')).toHaveCount(0);
});
