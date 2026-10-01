// e2e/fleet/counters (SPEC.md sections 6 and 8, ADR-017): every row shows the
// daemon's counters as they are: Draft / Branch / PR, unreviewed, high
// findings, last audit ("never" in phase 2), last event, and the collecting,
// error and git-only indicators.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

const NOW = new Date('2026-05-04T12:00:00.000Z');

const row = (page: Page, name: string): Locator => page.getByTestId('repo-row').filter({ has: page.getByRole('link', { name, exact: true }) });
const cell = (r: Locator, column: string): Locator => r.locator(`[data-col="${column}"]`);

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test('each row shows the counters from /api/repos', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  const list = page.getByTestId('fleet-list');
  await expect(list.getByRole('columnheader')).toHaveText(['Repo', 'Draft', 'Branch', 'PR', 'Unreviewed', 'High findings', 'Last audit', 'Last event']);
  await expect(page.getByTestId('repo-row')).toHaveCount(3);

  const shop = row(page, 'sample-shop');
  await expect(cell(shop, 'draft')).toHaveText('1');
  await expect(cell(shop, 'branch')).toHaveText('2');
  await expect(cell(shop, 'pr')).toHaveText('1');
  await expect(cell(shop, 'unreviewed')).toHaveText('3');
  await expect(cell(shop, 'high')).toHaveText('0');
  await expect(cell(shop, 'audit')).toHaveText('never audited');
  await expect(cell(shop, 'event')).toHaveText('41 min ago');
  await expect(shop.getByText('/work/sample-shop')).toBeVisible();

  const orders = row(page, 'order-service');
  await expect(cell(orders, 'pr')).toHaveText('2');
  await expect(cell(orders, 'event')).toHaveText('2 h ago');
  await expect(orders.getByTestId('collecting')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Repos/ })).toContainText('3');
});

test('rows keep the API order (latest activity first)', async ({ page }) => {
  await mockApi(page, { repos: fixtures.fleetIndicators() });
  await page.goto('/#/');
  await expect(page.getByTestId('repo-row').getByRole('link')).toHaveText(['billing-worker', 'media-pipeline', 'status-page', 'fresh-checkout']);
});

test('high findings, collect error, git-only and no events yet', async ({ page }) => {
  await mockApi(page, { repos: fixtures.fleetIndicators() });
  await page.goto('/#/');

  const billing = row(page, 'billing-worker');
  await expect(cell(billing, 'unreviewed')).toHaveText('8');
  await expect(cell(billing, 'high')).toHaveText('2');
  await expect(cell(billing, 'high')).toHaveClass(/high/);

  const media = row(page, 'media-pipeline');
  await expect(media.getByTestId('git-only')).toHaveText('working tree not watched (too large)');
  await expect(row(page, 'billing-worker').getByTestId('git-only')).toHaveCount(0);

  const status = row(page, 'status-page');
  await expect(status.getByTestId('collect-error')).toHaveText('error');
  await expect(status.getByTestId('collect-error')).toHaveAttribute('title', 'git rev-parse failed: not a git repository');
  await expect(status.getByText('git rev-parse failed: not a git repository')).toBeVisible();

  const fresh = row(page, 'fresh-checkout');
  await expect(fresh.getByTestId('collecting')).toHaveText('collecting');
  await expect(cell(fresh, 'event')).toHaveText('no events yet');

  // The lots carry the same indicators.
  await expect(page.locator('[data-testid="lot"][data-repo-id="13"]')).toHaveClass(/error/);
  await expect(page.locator('[data-testid="lot"][data-repo-id="14"]')).toHaveClass(/collecting/);
});
