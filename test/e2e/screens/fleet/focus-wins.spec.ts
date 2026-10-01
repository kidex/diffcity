// e2e/fleet/focus-wins: the keyboard-focused lot keeps the highlight (on the
// map and in the list) while the pointer rests on the list, also when a live
// update moves rows under the pointer. When the lot loses focus, hover works
// again.

import { expect, test, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

const lot = (page: Page, id: number) => page.locator(`[data-testid="lot"][data-repo-id="${String(id)}"]`);
const row = (page: Page, name: string) => page.getByTestId('repo-row').filter({ hasText: name });

test('a focused lot keeps the highlight while rows move under the pointer', async ({ page }, testInfo) => {
  const repos = fixtures.fleetThreeRepos();
  await mockApi(page, { repos });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  await lot(page, 2).focus();
  await expect(lot(page, 2)).toHaveClass(/hot/);

  // The pointer rests on the first row (sample-shop).
  await row(page, 'sample-shop').locator('[data-col="unreviewed"]').hover();
  await expect(lot(page, 2)).toHaveClass(/hot/);
  await expect(lot(page, 1)).not.toHaveClass(/hot/);
  await expect(row(page, 'order-service')).toHaveClass(/hot/);
  await expect(row(page, 'sample-shop')).not.toHaveClass(/hot/);

  // A live update moves docs-site to the first row, under the pointer.
  const docs = repos.splice(2, 1)[0];
  if (!docs) throw new Error('fleet-three-repos.json has no third repo');
  repos.unshift({ ...docs, lastEventAt: '2026-05-04T11:59:00.000Z' });
  await emitSse(page, testInfo.testId, 'repo', { repoId: docs.id });
  await expect(page.getByTestId('repo-row').first()).toContainText('docs-site');
  // Moving the pointer a little fires the row hover the reorder caused.
  await page.mouse.move(5, 5);
  await row(page, 'docs-site').locator('[data-col="unreviewed"]').hover();

  await expect(lot(page, 2)).toBeFocused();
  await expect(lot(page, 2)).toHaveClass(/hot/);
  await expect(lot(page, 3)).not.toHaveClass(/hot/);
  await expect(row(page, 'order-service')).toHaveClass(/hot/);
  await expect(row(page, 'docs-site')).not.toHaveClass(/hot/);
});

test('once the lot loses focus, row hover highlights again', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  await lot(page, 2).focus();
  await row(page, 'sample-shop').hover();
  await expect(lot(page, 1)).not.toHaveClass(/hot/);

  await page.evaluate('document.activeElement.blur()');
  await page.mouse.move(5, 5);
  await row(page, 'sample-shop').hover();
  await expect(lot(page, 1)).toHaveClass(/hot/);
  await expect(lot(page, 2)).not.toHaveClass(/hot/);
  await expect(row(page, 'sample-shop')).toHaveClass(/hot/);
});
