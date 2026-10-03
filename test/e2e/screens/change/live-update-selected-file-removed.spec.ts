// e2e/change/live-update-selected-file-removed (ADR-026): when the selected
// file is no longer in the Report after a live update, the selection is
// cleared, the card goes, and a toast says why. Another file's selection
// survives an update.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { GUARD, MIGRATION } from '../../support/hud.js';
import { openCity, project, selected, stats, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

test('change/live-update-selected-file-removed', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reports: Record<number, Report> = { 11: fixtures.reportGolden() };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const card = page.getByTestId('selection-card');
  const toast = page.getByTestId('toast');
  await expect(toast).toBeHidden();

  const guard = await project(page, GUARD);
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(card).toBeVisible();

  // An update that keeps the file keeps the selection, and refreshes the card.
  const same = fixtures.reportGolden();
  reports[11] = same;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'aaaaaaa' });
  await expect.poll(async () => (await stats(page)).frames).toBeGreaterThan(0);
  expect(await selected(page)).toBe(GUARD);
  await expect(toast).toBeHidden();

  // The guard goes away: selection cleared, card hidden, toast says so.
  const next = fixtures.reportGolden();
  const auth = next.packages.find((pkg) => pkg.path === 'src/auth');
  if (auth === undefined) throw new Error('src/auth missing');
  auth.files = auth.files.filter((file) => file.id !== GUARD);
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'bbbbbbb' });
  await expect.poll(async () => (await stats(page)).buildings).toBe(16);
  await waitForCityAttribute(page, 'data-selected', '');
  expect(await selected(page)).toBeNull();
  await expect(card).toBeHidden();
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText(`${GUARD} is no longer in this change`);

  // The rest of the city still selects.
  const migration = await project(page, MIGRATION);
  await page.mouse.click(migration.x, migration.y);
  await waitForCityAttribute(page, 'data-selected', MIGRATION);
  await expect(card).toBeVisible();
});
