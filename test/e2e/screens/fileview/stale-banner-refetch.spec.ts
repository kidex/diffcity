// e2e/fileview/stale-banner-refetch (ADR-027): a diff the daemon marks stale
// shows the banner "This file changed after the snapshot; a new one is being
// computed", and the next snapshot (update(report)) fetches it again; a diff
// that is not stale is fetched again only when the Report is a new one.

import { test } from '@playwright/test';
import { emitSse, tagClient } from '../../support/sse.js';
import { panelReport } from '../../support/panel.js';
import { sceneExpect as expect } from '../../support/scene.js';
import type { DiffRequest } from '../../support/fileview.js';
import { guardDiff, openDiff, scrollOf, setScroll } from '../../support/fileview.js';
import { openPanel } from '../../support/panel.js';
import { project, waitForCityAttribute } from '../../support/scene.js';
import { GUARD } from '../../support/hud.js';

test.describe.configure({ timeout: 90_000 });

test('fileview/stale-banner-refetch', async ({ page }, testInfo) => {
  await tagClient(page, testInfo.testId);
  const calls: DiffRequest[] = [];
  const reports = await openPanel(page, undefined, {
    diff: (request) => {
      calls.push(request);
      const diff = guardDiff({ symbolId: request.symbol, stale: request.call === 0 });
      // The second answer is the new snapshot's: one more line.
      if (request.call > 0 && diff.rows !== undefined) diff.stats = { ...diff.stats, added: diff.stats.added + 1 };
      return diff;
    },
  });
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const point = await project(page, GUARD);
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);

  const banner = page.getByTestId('diff-stale');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText('This file changed after the snapshot; a new one is being computed');
  await expect(page.getByTestId('diff-stats')).toHaveText('+5 −3');
  expect(calls).toHaveLength(1);

  // The reader is part-way down; the next snapshot arrives (same Report text, a later one).
  await setScroll(page, 190);
  const top = await scrollOf(page);
  const next = panelReport();
  next.meta = { ...next.meta, generatedAt: '2026-10-03T12:00:00.000Z' };
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'bbbbbbb' });
  await expect(banner).toBeHidden();
  await expect(page.getByTestId('diff-stats')).toHaveText('+6 −3');
  expect(calls).toHaveLength(2);
  expect(calls[1]?.path).toBe(GUARD);
  // The view stayed where it was while the new one arrived.
  expect(await scrollOf(page)).toBe(top);

  // The same Report again: a diff that is not stale is not fetched again.
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'bbbbbbb' });
  await expect(page.getByTestId('diff-view')).toBeVisible();
  await page.waitForTimeout(500);
  expect(calls).toHaveLength(2);

  // A newer Report is: the diff is of the latest snapshot.
  const newer = panelReport();
  newer.meta = { ...newer.meta, generatedAt: '2026-10-03T12:05:00.000Z' };
  reports[11] = newer;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'ccccccc' });
  await expect.poll(() => calls.length).toBe(3);
});

test('fileview/stale-banner-text-only', async ({ page }) => {
  await openDiff(page, ({ symbol }) => guardDiff({ symbolId: symbol, stale: true }));
  await expect(page.getByTestId('diff-stale')).toBeVisible();
  // Still readable under the banner.
  await expect(page.getByTestId('diff-row').first()).toBeVisible();
});
