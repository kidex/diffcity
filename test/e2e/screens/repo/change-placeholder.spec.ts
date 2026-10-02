// e2e/repo/change-placeholder: `#/change/:id` shows the change header (kind,
// ref, title) and the way back to the repo above the city of its Report. A
// change without a snapshot says it is computing, and fills in on SSE
// `snapshot` (the city itself: test/e2e/screens/change/).

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

test('header, city, back link', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await page.getByRole('link', { name: 'Add percentage discounts to orders' }).click();
  await expect(page).toHaveURL(/#\/change\/11$/);
  // The city's first frame compiles shaders; on SwiftShader that holds the page for a few seconds.
  await expect(page.getByTestId('city')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });

  const head = page.getByTestId('change-head');
  await expect(head.getByTestId('change-kind')).toHaveText('Branch');
  await expect(head.getByRole('heading', { level: 1 })).toHaveText('Add percentage discounts to orders');
  await expect(head.getByTestId('change-ref')).toHaveText('feature/order-discounts');
  await expect(page.getByTestId('city')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('roof-label')).toHaveCount(6);
  await expect(page.locator('[data-testid="roof-label"][data-building="src/payments/charge.ts"] .badge')).toHaveText('Needs your eyes');

  await page.getByTestId('back-to-repo').click();
  await expect(page).toHaveURL(/#\/repo\/1$/);
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

test('a PR whose head is not fetched says so, not computing', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/change/12');
  await expect(page.getByTestId('change-kind')).toHaveText('PR #7');
  await expect(page.getByTestId('change-ref')).toHaveCount(0);
  const note = page.getByTestId('head-not-fetched');
  await expect(note).toHaveText('head not fetched locally');
  await expect(note).toHaveAttribute('title', 'diffcity never runs git fetch. Fetch the pull request to see what it changes.');
  await expect(page.getByTestId('report-computing')).toHaveCount(0);
});

test('a change with its head but no snapshot yet is computing', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/change/13');
  await expect(page.getByTestId('change-kind')).toHaveText('Branch');
  await expect(page.getByTestId('report-computing')).toHaveText('Computing the first snapshot of this change…');
  await expect(page.getByTestId('head-not-fetched')).toHaveCount(0);
});

test('a change without a snapshot fills in on SSE snapshot', async ({ page }, testInfo) => {
  const reports = {};
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/change/11');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('report-computing')).toHaveText('Computing the first snapshot of this change…');

  Object.assign(reports, { 11: fixtures.reportOrderDiscounts() });
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });
  await expect(page.getByTestId('city')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('roof-label')).toHaveCount(6);
});

test('an archived change opens from the archive', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await page.getByTestId('archive-toggle').click();
  await page.getByRole('link', { name: 'Sell gift cards at checkout' }).click();
  await expect(page).toHaveURL(/#\/change\/21$/);
  await expect(page.getByTestId('change-head')).toContainText('Merged');
});

test('the header keeps its bottom padding over the stage title rule', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/change/11');
  await expect(page.getByTestId('change-head')).toHaveCSS('padding-bottom', '16px');
});
