// e2e/repo/live-burst (SPEC.md section 6, ADR-017): a burst of SSE `changes`
// and `snapshot` events for this repo, while a row deep in a 44-row list has
// keyboard focus, is coalesced into a few refetches, keeps the focus and the
// scroll position, does not reload the page and raises no error.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

test('40 events while a deep row is focused: focus and scroll kept, refetches coalesced', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewportSize({ width: 1024, height: 700 });
  const detail = fixtures.repoLongList();
  const api = await mockApi(page, { details: [detail] });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('change-row')).toHaveCount(44);

  const link = page.getByRole('link', { name: 'Change number 30 to the sample shop' });
  await link.focus();
  await expect(link).toBeFocused();
  await expect(link).toBeInViewport();
  await page.evaluate('window.noReload = true');
  const scrollTop = (): Promise<number> => page.evaluate<number>("Math.round(document.querySelector('.stage.repo').scrollTop)");
  const before = await scrollTop();
  expect(before).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  const fetchesBefore = api.count('/api/repos/1');

  // The last event of the burst carries a change: the list must end on it.
  detail.changes = detail.changes.map((change) => (change.id === 131 ? { ...change, title: 'Change number 31, renamed' } : change));
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0
        ? emitSse(page, testInfo.testId, 'changes', { repoId: 1 })
        : emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 100 + index, head: 'abc1234' }),
    ),
  );

  await expect(page.getByRole('link', { name: 'Change number 31, renamed' })).toBeVisible();
  await page.waitForTimeout(600);
  await expect(link).toBeFocused();
  expect(await scrollTop()).toBe(before);
  await expect(page.getByTestId('change-row')).toHaveCount(44);
  expect(api.count('/api/repos/1') - fetchesBefore).toBeLessThanOrEqual(4);
  expect(await page.evaluate<boolean>('window.noReload === true')).toBe(true);
  expect(errors).toEqual([]);
});
