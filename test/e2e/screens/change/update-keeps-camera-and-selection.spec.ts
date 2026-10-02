// e2e/change/update-keeps-camera-and-selection: on SSE `snapshot` the route
// hands the new Report to the screen it already mounted. The city gains the
// new building while the canvas, the camera and the selection stay.

import { expect, test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { camera, openCity, project, selected, stats, waitForCityAttribute } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test('change/update-keeps-camera-and-selection', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reports: Record<number, Report> = { 11: fixtures.reportGolden() };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  // Orbit a little, zoom in, then select the guard.
  const canvas = page.getByTestId('city-canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 15, { steps: 4 });
  await page.mouse.up();
  await page.mouse.wheel(0, -120);
  const guard = await project(page, 'src/auth/order.guard.ts');
  await page.mouse.click(guard.x, guard.y);
  await expect.poll(() => selected(page)).toBe('src/auth/order.guard.ts');
  const before = await camera(page);
  await page.evaluate('document.querySelector(\'[data-testid="city-canvas"]\').dataset.marker = "first"');

  const next = fixtures.reportGolden();
  const repo = next.packages.find((pkg) => pkg.path === 'src/repo');
  if (repo === undefined) throw new Error('src/repo missing');
  repo.files.push({
    id: 'src/repo/orders.audit.ts',
    path: 'src/repo/orders.audit.ts',
    language: 'typescript',
    status: 'add',
    verdict: 'ok',
    inSpec: null,
    symbols: [{ id: 'src/repo/orders.audit.ts#audit', name: 'audit', kind: 'function', status: 'add', range: { start: 1, end: 9 } }],
  });
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });

  await expect.poll(async () => (await stats(page)).buildings).toBe(18);
  await expect(page.locator('[data-building="src/repo/orders.audit.ts"]')).toHaveCount(1);
  expect(await camera(page)).toEqual(before);
  expect(await selected(page)).toBe('src/auth/order.guard.ts');
  await expect(canvas).toHaveAttribute('data-marker', 'first');
  await waitForCityAttribute(page, 'data-selected', 'src/auth/order.guard.ts');
});
