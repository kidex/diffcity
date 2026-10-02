// e2e/repo/change-placeholder: `#/change/:id` shows the change header (kind,
// ref, title) and the way back to the repo above the city of its Report. A
// change without a snapshot says it is computing, and fills in on SSE
// `snapshot`. The city itself is proved in test/e2e/screens/change/; these
// specs run without WebGL, so the Report shows as the touched-files table.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { withoutWebgl } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.beforeEach(async ({ page }) => {
  await withoutWebgl(page);
});

test('header, report, back link', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await page.getByRole('link', { name: 'Add percentage discounts to orders' }).click();
  await expect(page).toHaveURL(/#\/change\/11$/);
  await expect(page.getByTestId('touched-file')).toHaveCount(6);

  const head = page.getByTestId('change-head');
  await expect(head.getByTestId('change-kind')).toHaveText('Branch');
  await expect(head.getByRole('heading', { level: 1 })).toHaveText('Add percentage discounts to orders');
  await expect(head.getByTestId('change-ref')).toHaveText('feature/order-discounts');
  await expect(page.getByTestId('touched-file').filter({ hasText: 'src/payments/charge.ts' }).getByTestId('file-verdict')).toHaveText('Needs your eyes');

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
  await expect(page.getByTestId('report-computing')).toHaveCount(0);
  await expect(page.getByTestId('touched-file')).toHaveCount(6);
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
