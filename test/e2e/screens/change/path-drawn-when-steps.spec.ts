// e2e/change/path-drawn-when-steps (ADR-026): a Report with steps draws the
// reading path: a tube with packets, and a numbered ring at every stop, in the
// order of the steps. The packets run while motion is on.

import { test } from '@playwright/test';
import { effects, effectsReport } from '../../support/effects.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, stats, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('change/path-drawn-when-steps', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockApi(page, { reports: { 11: effectsReport() } });
  await openCity(page);

  const { path, continuous } = await effects(page);
  expect(path).toMatchObject({ stops: [1, 2, 3, 4], tube: true, animated: true, visible: true });
  expect(continuous).toBe(true);
  expect((await stats(page)).drawCalls).toBeLessThanOrEqual(40);
});

test('change/path-numbers-fit-the-texture-limit: 2,000 steps', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = effectsReport();
  const files = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.symbols.length > 0);
  report.steps = Array.from({ length: 2000 }, (_, i) => {
    const file = files[i % files.length];
    return { order: i + 1, symbolId: file?.symbols[0]?.id ?? '', fileId: file?.id ?? '', why: 'a stop', diff: [] };
  });
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);
  const { path } = await effects(page);
  expect(path?.stops).toHaveLength(2000);
  expect(path?.atlas.width).toBeLessThanOrEqual(path?.atlas.max ?? 0);
  expect(path?.atlas.height).toBeLessThanOrEqual(path?.atlas.max ?? 0);
  expect((await stats(page)).drawCalls).toBeLessThanOrEqual(40);
});
