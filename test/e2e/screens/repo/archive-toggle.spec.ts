// e2e/repo/archive-toggle (SPEC.md section 3a, L7): the archive toggle lists
// the archived changes from `?archived=1`, read-only, each with the reason it
// left and the date; toggling back shows the live list.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.use({ timezoneId: 'UTC' });

test('archived changes show their reason and date, read-only', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  expect(api.requests.some((url) => url.pathname === '/api/repos/1/changes')).toBe(false);

  const toggle = page.getByTestId('archive-toggle');
  await expect(toggle).toHaveText('Show closed changes (4)');
  await expect(toggle).toHaveAccessibleDescription('Merged, deleted, closed or cleaned changes, kept for 90 days');
  await toggle.click();
  await expect(toggle).toHaveText('Back to open changes');
  await expect(page.getByTestId('change-row')).toHaveCount(4);
  const request = api.requests.find((url) => url.pathname === '/api/repos/1/changes');
  expect(request?.searchParams.get('archived')).toBe('1');

  await expect(page.locator('.repo .changes h2')).toHaveText('Closed changes');
  await expect(page.getByTestId('change-count-text')).toHaveText('4 closed changes');
  await expect(page.getByTestId('archive-reason')).toHaveText(['Merged', 'PR closed', 'Draft cleaned', 'Branch deleted']);
  await expect(page.getByTestId('archived-at')).toHaveText(['3 May 2026', '30 Apr 2026', '21 Apr 2026', '12 Apr 2026']);
  await expect(page.getByTestId('archived-at').first()).toHaveAttribute('datetime', '2026-05-03T09:00:00.000Z');
  // Read-only: no review badges, no agent badge.
  await expect(page.getByTestId('review-state')).toHaveCount(0);
  await expect(page.getByTestId('agent-badge')).toHaveCount(0);
  // The filters count the archive.
  await expect(page.getByRole('group', { name: 'Filter by kind' }).getByRole('button')).toHaveText(['Draft 1', 'Branch 2', 'PR 1']);

  await toggle.click();
  await expect(toggle).toHaveText('Show closed changes (4)');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.locator('.repo .changes h2')).toHaveText('Open changes');
});

test('an empty archive says so', async ({ page }) => {
  await mockApi(page, { archived: {} });
  await page.goto('/#/repo/1');
  await page.getByTestId('archive-toggle').click();
  await expect(page.getByTestId('list-empty')).toHaveText('No change closed in the last 90 days.');
});

// DC-64: the toggle carries the number of closed changes, or says there are none and still opens the (explaining) list.
test('the toggle label says there are no closed changes, and still opens the list', async ({ page }) => {
  const detail = fixtures.repoMixedChanges();
  await mockApi(page, { archived: {}, details: [{ ...detail, repo: { ...detail.repo, archivedCount: 0 } }] });
  await page.goto('/#/repo/1');
  const toggle = page.getByTestId('archive-toggle');
  await expect(toggle).toHaveText('No closed changes');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveText('Back to open changes');
  await expect(page.getByTestId('list-empty')).toHaveText('No change closed in the last 90 days.');
});

test('a repo update moves the count in the toggle label', async ({ page }, testInfo) => {
  const detail = fixtures.repoMixedChanges();
  let archivedCount = 0;
  await mockApi(page);
  await page.route('**/api/repos/1', (route) => route.fulfill({ json: { ...detail, repo: { ...detail.repo, archivedCount } } }));
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  const toggle = page.getByTestId('archive-toggle');
  await expect(toggle).toHaveText('No closed changes');
  archivedCount = 1;
  await emitSse(page, testInfo.testId, 'repo', { repoId: 1 });
  await expect(toggle).toHaveText('Show closed changes (1)');
});

test('a failed archive fetch says so until the next successful refetch', async ({ page }, testInfo) => {
  await mockApi(page);
  let failing = true;
  await page.route('**/api/repos/1/changes?archived=1', async (route) => {
    if (failing) await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'boom' } } });
    else await route.fallback();
  });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await page.getByTestId('archive-toggle').click();
  await expect(page.getByTestId('list-empty')).toHaveText('Can’t load the closed changes right now.');
  await expect(page.getByTestId('change-row')).toHaveCount(0);

  failing = false;
  await emitSse(page, testInfo.testId, 'changes', { repoId: 1 });
  await expect(page.getByTestId('change-row')).toHaveCount(4);
  await expect(page.getByTestId('list-empty')).toBeHidden();
});
