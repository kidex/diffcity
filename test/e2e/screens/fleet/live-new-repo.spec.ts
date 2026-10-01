// e2e/fleet/live-new-repo (SPEC.md section 6, ADR-017): SSE events are
// signals; the Fleet refetches /api/repos without a reload, coalesced to one
// refetch per 250 ms.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

test('SSE repo → a new repo appears by itself, with no reload', async ({ page }, testInfo) => {
  const repos = fixtures.fleetThreeRepos();
  await mockApi(page, { repos });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('lot')).toHaveCount(3);
  // A reload would drop this marker.
  await page.evaluate('window.noReload = true');

  const added = fixtures.fleetNewRepo();
  repos.unshift(added);
  expect(await emitSse(page, testInfo.testId, 'repo', { repoId: added.id })).toBe(1);

  await expect(page.getByTestId('lot')).toHaveCount(4);
  await expect(page.locator('[data-testid="lot"][data-repo-id="4"]')).toHaveAttribute('aria-label', /^inventory-api, 1 unreviewed change/);
  await expect(page.getByTestId('repo-row').first()).toContainText('inventory-api');
  expect(await page.evaluate<boolean>('window.noReload === true')).toBe(true);
});

test('SSE collect → the collecting indicator follows the daemon', async ({ page }, testInfo) => {
  const repos = fixtures.fleetThreeRepos();
  await mockApi(page, { repos });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const row = page.getByTestId('repo-row').filter({ hasText: 'sample-shop' });
  await expect(row.getByTestId('collecting')).toHaveCount(0);

  const [shop] = repos;
  if (!shop) throw new Error('fleet-three-repos.json is empty');
  repos[0] = { ...shop, collecting: true };
  await emitSse(page, testInfo.testId, 'collect', { repoId: 1, state: 'started' });
  await expect(row.getByTestId('collecting')).toBeVisible();
  await expect(page.locator('[data-testid="lot"][data-repo-id="1"]')).toHaveClass(/collecting/);

  repos[0] = { ...shop, collecting: false, unreviewed: 5, counts: { draft: 2, branch: 2, pr: 1 } };
  await emitSse(page, testInfo.testId, 'collect', { repoId: 1, state: 'done' });
  await expect(row.getByTestId('collecting')).toHaveCount(0);
  await expect(row.locator('[data-col="unreviewed"]')).toHaveText('5');
  await expect(row.locator('[data-col="draft"]')).toHaveText('2');
  await expect(page.locator('[data-testid="lot"][data-repo-id="1"] .count')).toHaveText('5');
});

test('a burst of events is coalesced into few refetches', async ({ page }, testInfo) => {
  const api = await mockApi(page);
  await tagClient(page, testInfo.testId);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('lot')).toHaveCount(3);
  // Let the start-up refetches (mount, hello) settle.
  await page.waitForTimeout(400);
  const before = api.count('/api/repos');

  for (let i = 0; i < 8; i++) await emitSse(page, testInfo.testId, 'repo', { repoId: 1 });
  await page.waitForTimeout(700);
  const refetches = api.count('/api/repos') - before;
  expect(refetches).toBeGreaterThanOrEqual(1);
  // 8 events within well under a second: at most one now and one per 250 ms after.
  expect(refetches).toBeLessThanOrEqual(3);
});
