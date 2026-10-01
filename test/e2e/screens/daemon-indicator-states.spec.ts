// e2e/daemon-indicator-states (SPEC.md section 6, ADR-017): connected after
// `hello`, reconnecting after an error for up to 5 s, offline after that, and
// connected again when the daemon is back, refetching what is visible.

import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../support/mock-api.js';

const indicator = (page: Page) => page.getByTestId('daemon');

/** Tags this test's SSE streams so the stub server drops only them. */
async function tagClient(page: Page, id: string): Promise<void> {
  await page.context().addCookies([{ name: 'e2e-client', value: id, domain: '127.0.0.1', path: '/' }]);
}

test('connected after hello', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  await expect(indicator(page)).toHaveAttribute('data-state', 'connected');
  await expect(indicator(page)).toHaveText('Connected');
});

test('connected → reconnecting → offline → connected when the daemon goes away and comes back', async ({ page }, testInfo) => {
  test.setTimeout(30_000);
  const api = await mockApi(page);
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(indicator(page)).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('sample-shop');

  // The daemon stops: the open stream drops and every reconnect fails.
  await page.route('**/api/events', (route) => route.fulfill({ status: 503, body: 'daemon stopped' }));
  const dropped = await page.request.post(`/__stub/sse/drop?client=${encodeURIComponent(testInfo.testId)}`);
  expect(((await dropped.json()) as { dropped: number }).dropped).toBe(1);
  const lostAt = Date.now();

  await expect(indicator(page)).toHaveAttribute('data-state', 'reconnecting');
  await expect(indicator(page)).toHaveText('Reconnecting');
  await expect(indicator(page)).toHaveAttribute('data-state', 'offline', { timeout: 8_000 });
  await expect(indicator(page)).toHaveText('Offline');
  expect(Date.now() - lostAt).toBeGreaterThanOrEqual(4_500);

  // The daemon is back: the next attempt gets a stream and a hello, and the
  // UI refetches what is on screen.
  const before = api.count('/api/repos/1');
  await page.unroute('**/api/events');
  await expect(indicator(page)).toHaveAttribute('data-state', 'connected', { timeout: 8_000 });
  await expect.poll(() => api.count('/api/repos/1')).toBeGreaterThan(before);
});

test('reconnecting at start, then offline, when no daemon answers', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/events', (route) => route.abort('connectionrefused'));
  await page.goto('/#/');
  await expect(indicator(page)).toHaveAttribute('data-state', 'reconnecting');
  await expect(indicator(page)).toHaveAttribute('data-state', 'offline', { timeout: 8_000 });
  // The one command to start the daemon (SPEC.md section 3).
  await expect(indicator(page)).toHaveAttribute('title', 'The diffcity daemon is not reachable. Start it with: diffcity start');
});
