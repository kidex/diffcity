// e2e/change/live-update-shape-change-no-compile (DC-110): a live update
// that changes the towers' instance count (a new file) builds new towers and
// a new city, but compiles no shader program: the replaced content is freed
// only after the new one is drawn, so its materials take the cached programs
// over. Compiling them again cost seconds a frame on SwiftShader.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { openCity, stats, sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

const NEW_FILE = 'src/repo/orders.audit.ts';

test('change/live-update-shape-change-no-compile', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const reports: Record<number, Report> = { 11: fixtures.reportGolden() };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.quality().settled'), { timeout: 60_000 }).toBe(true);
  await page.evaluate('window.diffcityScene.bench(300)');
  const before = await stats(page);
  expect(before.lastProgram).toBeGreaterThanOrEqual(0);

  const next = fixtures.reportGolden();
  const repo = next.packages.find((pkg) => pkg.path === 'src/repo');
  if (repo === undefined) throw new Error('src/repo missing');
  repo.files.push({
    id: NEW_FILE,
    path: NEW_FILE,
    language: 'typescript',
    status: 'add',
    verdict: 'ok',
    inSpec: null,
    symbols: ['audit', 'record'].map((name, i) => ({ id: `${NEW_FILE}#${name}`, name, kind: 'function' as const, status: 'add' as const, range: { start: 1 + i * 6, end: 5 + i * 6 } })),
  });
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });

  // New towers and a new city, drawn...
  await expect.poll(async () => (await stats(page)).buildings).toBe(before.buildings + 1);
  await page.evaluate('window.diffcityScene.bench(300)');
  const after = await stats(page);
  expect(after.builds).toBeGreaterThan(before.builds);
  expect(after.layouts).toBeGreaterThan(before.layouts);
  // ...with the programs that were there: no frame compiled one.
  expect(after.lastProgram).toBe(before.lastProgram);
});
