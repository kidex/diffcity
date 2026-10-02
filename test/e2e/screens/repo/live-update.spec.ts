// e2e/repo/live-update (SPEC.md section 6, ADR-017): SSE `changes` and
// `snapshot` for this repo refetch the list in place, with no reload; the
// focused row link keeps its focus. Events for other repos are ignored.

import { expect, test } from '@playwright/test';
import type { ChangeSummary } from '../../../../src/core/model/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

test('SSE changes → a new change appears at the top, focus kept, no reload', async ({ page }, testInfo) => {
  const detail = fixtures.repoMixedChanges();
  await mockApi(page, { details: [detail] });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await page.evaluate('window.noReload = true');

  const link = page.getByRole('link', { name: 'Round cart totals once' });
  await link.focus();
  await expect(link).toBeFocused();

  const [first] = detail.changes;
  if (!first) throw new Error('repo-mixed-changes.json has no change');
  const added: ChangeSummary = {
    ...first,
    id: 16,
    ref: 'branch:feature/wishlist',
    title: 'Add a wishlist',
    lastEvent: { type: 'agent', at: '2026-05-04T11:59:00.000Z' },
    stats: null,
  };
  detail.changes.unshift(added);
  expect(await emitSse(page, testInfo.testId, 'changes', { repoId: 1 })).toBe(1);

  await expect(page.getByTestId('change-row')).toHaveCount(7);
  await expect(page.getByTestId('change-row').first()).toHaveAttribute('data-change-id', '16');
  await expect(link).toBeFocused();
  expect(await page.evaluate<boolean>('window.noReload === true')).toBe(true);
});

test('SSE snapshot → a computing change gets its counters, focus kept', async ({ page }, testInfo) => {
  const detail = fixtures.repoMixedChanges();
  await mockApi(page, { details: [detail] });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const row = page.locator('[data-testid="change-row"][data-change-id="13"]');
  await expect(row.getByTestId('computing')).toBeVisible();
  const link = row.getByRole('link');
  await link.focus();

  detail.changes = detail.changes.map((change) =>
    change.id === 13
      ? {
          ...change,
          stats: {
            touchedFiles: 1,
            symbolsByStatus: { add: 0, mod: 1, sig: 0, del: 0, same: 2 },
            filesByVerdict: { eyes: 0, risky: 0, spec: 0, ok: 1, same: 0 },
            tier1Files: [],
          },
        }
      : change,
  );
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 13, head: '0a1b2c3' });

  await expect(row.getByTestId('computing')).toHaveCount(0);
  await expect(row.getByTestId('touched').locator('.stat').first()).toHaveText('1 file');
  await expect(row.getByTestId('verdicts').locator('.tag')).toHaveText(['1 Reviewed, fine']);
  await expect(row.getByTestId('no-flags')).toHaveText('Nothing flagged');
  await expect(link).toBeFocused();
});

test('active filters survive a live update', async ({ page }, testInfo) => {
  const detail = fixtures.repoMixedChanges();
  await mockApi(page, { details: [detail] });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const branch = page.getByRole('group', { name: 'Filter by kind' }).getByRole('button', { name: /^Branch/ });
  await branch.click();
  await expect(page.getByTestId('change-row')).toHaveCount(3);
  await branch.focus();

  detail.changes = detail.changes.map((change) => (change.id === 10 ? { ...change, kind: 'branch', ref: 'branch:chore/tidy' } : change));
  await emitSse(page, testInfo.testId, 'changes', { repoId: 1 });
  await expect(page.getByTestId('change-row')).toHaveCount(4);
  await expect(branch).toHaveText('Branch 4');
  await expect(branch).toHaveAttribute('aria-pressed', 'true');
  await expect(branch).toBeFocused();
});

test('events for another repo do not refetch this one', async ({ page }, testInfo) => {
  const api = await mockApi(page);
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await page.waitForTimeout(400);
  const before = api.count('/api/repos/1');
  await emitSse(page, testInfo.testId, 'changes', { repoId: 2 });
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 2, changeId: 30, head: 'abc1234' });
  await page.waitForTimeout(500);
  expect(api.count('/api/repos/1')).toBe(before);
});
