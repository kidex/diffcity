// e2e/fleet/focus-kept (ADR-022: "keeps focus and scroll position across live
// updates"): a live refetch or the relative-time clock updates the Fleet in
// place, so the keyboard user's focus stays where it was.

import { expect, test, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

/** The row of sample-shop and its name link (the lot's link has a longer accessible name). */
function shopRow(page: Page) {
  const name = { name: 'sample-shop', exact: true } as const;
  const row = page.getByTestId('repo-row').filter({ has: page.getByRole('link', name) });
  return { row, link: row.getByRole('link', name) };
}

test('a focused row link keeps focus when its repo changes over SSE', async ({ page }, testInfo) => {
  const repos = fixtures.fleetThreeRepos();
  await mockApi(page, { repos });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const { row, link } = shopRow(page);
  await link.focus();
  await expect(link).toBeFocused();

  const [shop] = repos;
  if (!shop) throw new Error('fleet-three-repos.json is empty');
  repos[0] = { ...shop, collecting: true, unreviewed: 4, error: 'index.lock exists', watch: 'git-only' };
  await emitSse(page, testInfo.testId, 'collect', { repoId: shop.id, state: 'started' });

  await expect(row.getByTestId('collecting')).toBeVisible();
  await expect(row.locator('[data-col="unreviewed"]')).toHaveText('4');
  await expect(row.getByTestId('git-only')).toBeVisible();
  await expect(link).toBeFocused();
});

test('a focused row link keeps focus when the clock redraws relative times', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-05-04T12:00:00.000Z') });
  await mockApi(page);
  await page.goto('/#/');
  const { row, link } = shopRow(page);
  const event = row.locator('[data-col="event"]');
  await expect(event).toHaveText('41 min ago');
  await link.focus();

  await page.clock.runFor(31_000 + 60_000);
  await expect(event).toHaveText('42 min ago');
  await expect(link).toBeFocused();
});
