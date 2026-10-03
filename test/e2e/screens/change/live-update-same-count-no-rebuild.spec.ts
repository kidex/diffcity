// e2e/change/live-update-same-count-no-rebuild (ADR-026, DC-79): a live
// update that moves buildings without changing how many instances the towers
// need (two files swap places) tweens in the buffers that are there. The
// towers' instanced buffers are built once for the new Report and never again
// on the tween's frames, and the renderer holds as many geometries after the
// tween as before it.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { openCity, stats, sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

interface Trace {
  id: string;
  heights: number[];
}

test('change/live-update-same-count-no-rebuild', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const reports: Record<number, Report> = { 11: fixtures.reportGolden() };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect.poll(async () => (await page.evaluate<boolean>('window.diffcityScene.tweening()')), { timeout: 30_000 }).toBe(false);

  const before = await stats(page);
  const next = fixtures.reportGolden();
  const services = next.packages.find((pkg) => pkg.path === 'src/services/orders');
  if (services === undefined) throw new Error('src/services/orders missing');
  // Same files, same floors: only the order, so the lot's buildings change places.
  services.files.reverse();
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });

  await expect.poll(() => page.evaluate<Trace | null>('window.diffcityScene.tweenTrace()')).not.toBeNull();
  await expect.poll(async () => (await page.evaluate<boolean>('window.diffcityScene.tweening()')), { timeout: 30_000 }).toBe(false);
  const trace = await page.evaluate<Trace | null>('window.diffcityScene.tweenTrace()');
  if (trace === null) throw new Error('no tween trace');
  expect(trace.heights.length).toBeGreaterThanOrEqual(2);

  const after = await stats(page);
  expect(after.buildings).toBe(before.buildings);
  expect(after.floors).toBe(before.floors);
  // One build for the new Report; none for the tween frames in between.
  expect(after.builds - before.builds).toBe(1);
  expect(after.geometries).toBe(before.geometries);
});
