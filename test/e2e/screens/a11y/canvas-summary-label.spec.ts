// e2e/a11y/canvas-summary-label (DC-89): the city's canvas is an image with an
// accessible name that summarises the change from `summary` alone: the files,
// how many need your eyes, the signature changes, and how to reach buildings
// by keyboard. A live update changes it with the Report.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { emitSse, tagClient } from '../../support/sse.js';
import { mockApi } from '../../support/mock-api.js';
import { panelReport } from '../../support/panel.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('a11y/canvas-summary-label', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = panelReport();
  const reports: Record<number, Report> = { 11: report };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);

  const { summary } = report;
  const canvas = page.getByTestId('city-canvas');
  await expect(canvas).toHaveAttribute('role', 'img');
  const label = (await canvas.getAttribute('aria-label')) ?? '';
  expect(label.startsWith(`${String(summary.files)} files, ${String(summary.byVerdict.eyes)} need your eyes, `)).toBe(true);
  expect(label).toContain(`${String(summary.byStatus.sig)} signature change`);
  expect(label).toContain(`${String(summary.byStatus.add)} symbols added`);
  expect(label).toContain(`${String(summary.byStatus.mod)} modified`);
  expect(label).toContain(`${String(summary.tier1Files.length)} files in tier 1`);
  expect(label).toContain('press ] and [');
  // The name is the summary, not the Report's own text: no path of the change leaks into it.
  expect(label).not.toContain('order.guard');

  // The Report changes: the name follows its summary.
  const next = panelReport();
  next.summary = { ...next.summary, files: next.summary.files + 1, byVerdict: { ...next.summary.byVerdict, eyes: 1 }, byStatus: { ...next.summary.byStatus, sig: 1 } };
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });
  await expect(canvas).toHaveAttribute('aria-label', new RegExp(`^${String(next.summary.files)} files, 1 needs your eyes, 1 signature change, `));
});
