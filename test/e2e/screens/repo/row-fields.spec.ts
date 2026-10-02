// e2e/repo/row-fields (SPEC.md section 3a, L6): every field of the change
// record is in its row, as the daemon sent it: the Draft / Branch / PR #N
// label, title, ref, ahead/behind, the uncommitted changes marker, touched
// files and symbols by status, verdict counters with the §5.2 labels, the
// review state, the last event with its relative time.

import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

const row = (page: Page, id: number) => page.locator(`[data-testid="change-row"][data-change-id="${String(id)}"]`);

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-05-04T12:00:00.000Z'));
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

test('a branch row shows every field', async ({ page }) => {
  const branch = row(page, 11);
  await expect(branch.getByTestId('kind')).toHaveText('Branch');
  await expect(branch.getByRole('link', { name: 'Add percentage discounts to orders' })).toHaveAttribute('href', '#/change/11');
  await expect(branch.getByTestId('ref')).toHaveText('feature/order-discounts');
  await expect(branch.locator('.where')).toContainText('against main');
  await expect(branch.getByTestId('ahead-behind')).toHaveText('2 ahead, 0 behind');
  await expect(branch.getByTestId('dirty')).toHaveCount(0);
  await expect(branch.getByTestId('review-state')).toHaveText('Unreviewed');
  await expect(branch.getByTestId('last-event')).toHaveText('Agent worked 41 min ago');
  await expect(branch.locator('[data-testid="last-event"] time')).toHaveAttribute('datetime', '2026-05-04T11:19:00.000Z');

  const touched = branch.getByTestId('touched');
  await expect(touched.locator('.stat')).toHaveText(['6 files', '10 added', '8 modified', '1 signature', '1 removed']);
  await expect(branch.getByTestId('verdicts').locator('.tag')).toHaveText(['2 Needs your eyes', '1 Outside the spec', '3 Untouched']);
});

test('a draft shows its working tree and the uncommitted changes marker', async ({ page }) => {
  const draft = row(page, 10);
  await expect(draft.getByTestId('kind')).toHaveText('Draft');
  await expect(draft.getByTestId('change-title')).toHaveText('Uncommitted changes on main');
  await expect(draft.getByTestId('ref')).toHaveText('main working tree');
  await expect(draft.getByTestId('dirty')).toHaveText('uncommitted changes');
  await expect(draft.getByTestId('last-event')).toHaveText('Collected 1 h ago');
});

test('a branch with folded uncommitted changes is marked, with its review state', async ({ page }) => {
  const branch = row(page, 14);
  await expect(branch.getByTestId('dirty')).toBeVisible();
  await expect(branch.getByTestId('review-state')).toHaveText('In review');
  await expect(branch.getByTestId('ahead-behind')).toHaveText('4 ahead, 1 behind');
  await expect(branch.getByTestId('last-event')).toHaveText('Reviewed 19 h ago');
});

test('a pull request is labelled PR #N, with its review state and verdicts', async ({ page }) => {
  const pr = row(page, 15);
  await expect(pr.getByTestId('kind')).toHaveText('PR #9');
  await expect(pr.getByTestId('ref')).toHaveCount(0);
  await expect(pr.getByTestId('review-state')).toHaveText('Approved');
  await expect(pr.getByTestId('verdicts').locator('.tag')).toHaveText(['1 Risky', '1 Reviewed, fine', '1 Untouched']);
  await expect(pr.getByTestId('last-event')).toHaveText('Reviewed 2 days ago');
});

test('zero status counters are hidden, zero verdicts are left out', async ({ page }) => {
  const draft = row(page, 10);
  await expect(draft.locator('.stat[data-status="sig"]')).toHaveClass(/zero/);
  await expect(draft.locator('.stat[data-status="sig"]')).toBeHidden();
  await expect(draft.locator('.stat[data-status="add"]')).not.toHaveClass(/zero/);
  await expect(draft.locator('.stat[data-status="add"]')).toBeVisible();
  await expect(draft.getByTestId('verdicts').locator('.tag')).toHaveText(['2 Untouched']);
  await expect(draft.getByTestId('no-flags')).toHaveText('Nothing flagged');
});

test('the list header counts the changes', async ({ page }) => {
  await expect(page.locator('.repo .changes h2')).toHaveText('Open changes');
  await expect(page.locator('.repo .changes .cnt')).toHaveText('6');
  await expect(page.locator('.repo-head h1')).toHaveText('sample-shop');
  await expect(page.locator('.repo-head .path')).toHaveText('/work/sample-shop');
});
