// e2e/repo/archive-daemon-down (SPEC.md section 3a, ADR-017): with the daemon
// gone, the archive toggle still switches views: the archive says it cannot
// load, toggling back shows the live list already on screen, and when the
// daemon comes back the `hello` refetch fills the archive.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { tagClient } from '../../support/sse.js';

test('archive toggle while the daemon is down, then back', async ({ page }, testInfo) => {
  test.setTimeout(30_000);
  await mockApi(page);
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('change-row')).toHaveCount(6);

  // The daemon stops: the stream drops, reconnects fail, the archive cannot load.
  await page.route('**/api/events', (route) => route.fulfill({ status: 503, body: 'daemon stopped' }));
  await page.route('**/api/repos/1/changes?archived=1', (route) => route.abort('connectionrefused'));
  await page.request.post(`/__stub/sse/drop?client=${encodeURIComponent(testInfo.testId)}`);
  await expect(page.getByTestId('daemon')).not.toHaveAttribute('data-state', 'connected');

  const toggle = page.getByTestId('archive-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('list-empty')).toHaveText('Can’t load the archive right now.');
  await expect(page.getByTestId('change-row')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.getByTestId('list-empty')).toBeHidden();

  await toggle.click();
  await expect(page.getByTestId('list-empty')).toHaveText('Can’t load the archive right now.');

  // The daemon is back: hello refetches the archive that is on screen.
  await page.unroute('**/api/repos/1/changes?archived=1');
  await page.unroute('**/api/events');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected', { timeout: 10_000 });
  await expect(page.getByTestId('change-row')).toHaveCount(4);
  await expect(page.getByTestId('archive-reason')).toHaveText(['Merged', 'PR closed', 'Draft cleaned', 'Branch deleted']);
  await expect(page.getByTestId('list-empty')).toBeHidden();
});
