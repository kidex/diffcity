// e2e/fleet/focus-kept (ADR-022: "keeps focus and scroll position across live
// updates"): a live refetch or the relative-time clock updates the Fleet in
// place, and a reorder moves the focused lot or row without blurring it, so
// the keyboard user's focus stays where it was.

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

for (const browser of ['with moveBefore', 'without moveBefore'] as const) {
  test(`a focused lot keeps focus when SSE moves it to first (${browser})`, async ({ page }, testInfo) => {
    // Older browsers have no Element.moveBefore: renderList then moves with
    // insertBefore and puts focus back.
    if (browser === 'without moveBefore') await page.addInitScript('delete Element.prototype.moveBefore');
    const repos = fixtures.fleetThreeRepos();
    await mockApi(page, { repos });
    await tagClient(page, testInfo.testId);
    await page.goto('/#/');
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
    expect(await page.evaluate<boolean>('typeof Element.prototype.moveBefore === "function"')).toBe(browser === 'with moveBefore');

    const lot = page.locator('[data-testid="lot"][data-repo-id="3"]');
    await expect(page.getByTestId('lot').last()).toHaveAttribute('data-repo-id', '3');
    await lot.focus();
    await expect(lot).toBeFocused();

    // docs-site gets a new event: the daemon now lists it first.
    const docs = repos.splice(2, 1)[0];
    if (!docs) throw new Error('fleet-three-repos.json has no third repo');
    repos.unshift({ ...docs, lastEventAt: '2026-05-04T11:59:00.000Z', unreviewed: 2 });
    await emitSse(page, testInfo.testId, 'repo', { repoId: docs.id });

    await expect(page.getByTestId('lot').first()).toHaveAttribute('data-repo-id', '3');
    await expect(page.getByTestId('repo-row').first()).toContainText('docs-site');
    await expect(lot).toBeFocused();
    await expect(lot).toHaveClass(/hot/);
  });

  test(`a focused row link keeps focus when SSE moves its row to first (${browser})`, async ({ page }, testInfo) => {
    if (browser === 'without moveBefore') await page.addInitScript('delete Element.prototype.moveBefore');
    const repos = fixtures.fleetThreeRepos();
    await mockApi(page, { repos });
    await tagClient(page, testInfo.testId);
    await page.goto('/#/');
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

    const link = page.getByTestId('repo-row').getByRole('link', { name: 'docs-site', exact: true });
    await link.focus();
    await expect(link).toBeFocused();

    const docs = repos.splice(2, 1)[0];
    if (!docs) throw new Error('fleet-three-repos.json has no third repo');
    repos.unshift({ ...docs, lastEventAt: '2026-05-04T11:59:00.000Z' });
    await emitSse(page, testInfo.testId, 'repo', { repoId: docs.id });

    await expect(page.getByTestId('repo-row').first()).toContainText('docs-site');
    await expect(link).toBeFocused();
  });
}
