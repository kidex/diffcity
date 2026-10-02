// e2e/fleet/live-burst (SPEC.md section 6, ADR-017, ADR-022): a burst of
// live events while the user hovers or focuses a lot leaves the Fleet
// consistent: the hovered or focused lot keeps its card, the card shows the
// last data, focus never drops, and the page raises no error.

import { expect, test, type Page } from '@playwright/test';
import type { RepoSummary } from '../../../../src/core/model/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

// The last event's refetch runs at most one coalescing interval (250 ms) after
// the burst, then a round trip and a render. A runner that is still busy with
// the specs before it can hold the page for seconds, so convergence on the
// last data waits longer than the 5 s default; it still fails if the card
// never reaches the last data.
const SETTLE = { timeout: 20_000 };

const tip = (page: Page) => page.locator('.fleet-map .tip');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

async function openLive(page: Page, repos: RepoSummary[], client: string): Promise<void> {
  await mockApi(page, { repos });
  await tagClient(page, client);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('lot')).toHaveCount(repos.length);
}

test('a burst while a lot is hovered keeps its card and ends on the last data', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  const repos = fixtures.fleetThreeRepos();
  await openLive(page, repos, testInfo.testId);
  const lot = page.locator('[data-testid="lot"][data-repo-id="2"]');
  await lot.hover();
  await expect(tip(page)).toHaveClass(/show/);

  // Counts that do not change a lot's size, so the lot stays under the pointer.
  for (let draft = 1; draft <= 20; draft++) {
    repos.forEach((repo, index) => {
      repos[index] = { ...repo, counts: { ...repo.counts, draft } };
    });
    await emitSse(page, testInfo.testId, draft % 2 === 0 ? 'repo' : 'collect', draft % 2 === 0 ? { repoId: 2 } : { repoId: 2, state: 'started' });
    await expect(tip(page)).toHaveClass(/show/);
  }
  await expect(tip(page).locator('.row b').first()).toHaveText('20', SETTLE);
  await expect(tip(page).locator('.f')).toHaveText('order-service');
  await expect(lot).toHaveClass(/hot/);
  await expect(page.getByTestId('repo-row').filter({ hasText: 'order-service' }).locator('[data-col="draft"]')).toHaveText('20', SETTLE);
  expect(errors).toEqual([]);
});

test('a burst that resizes, reorders and adds lots keeps keyboard focus and the card', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  const repos = fixtures.fleetThreeRepos();
  const original = [...repos];
  await openLive(page, repos, testInfo.testId);
  // Keep the pointer away from the map and the list.
  await page.mouse.move(1, 1);
  const lot = page.locator('[data-testid="lot"][data-repo-id="3"]');
  await lot.focus();
  await expect(tip(page)).toContainText('docs-site');

  for (let step = 1; step <= 15; step++) {
    const next = original.map((repo, index) => ({ ...repo, unreviewed: (repo.unreviewed + step * (index + 1)) % 9, counts: { ...repo.counts, pr: step } }));
    if (step % 2 === 0) next.reverse();
    const extra = step % 3 === 0 ? [{ ...fixtures.fleetNewRepo(), id: 900 + step, name: `burst-repo-${String(step)}` }] : [];
    repos.splice(0, repos.length, ...extra, ...next);
    await emitSse(page, testInfo.testId, 'repo', { repoId: 3 });
    await page.waitForTimeout(30);
  }

  await expect(lot).toBeFocused();
  await expect(lot).toHaveClass(/hot/);
  await expect(tip(page)).toHaveClass(/show/);
  await expect(tip(page).locator('.f')).toHaveText('docs-site');
  await expect(tip(page).locator('.row b').nth(2)).toHaveText('15', SETTLE);
  const expected = repos.find((repo) => repo.id === 3);
  await expect(lot.locator('.count')).toHaveText(String(expected?.unreviewed), SETTLE);
  await expect(page.getByTestId('lot')).toHaveCount(repos.length, SETTLE);
  expect(errors).toEqual([]);
});
