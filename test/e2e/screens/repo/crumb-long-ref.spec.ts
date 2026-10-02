// e2e/repo/crumb-long-ref (DC-55): a long ref in the breadcrumb ends in an
// ellipsis, keeps its full text as the accessible name and in a title, and
// Search keeps its name when its label is hidden.

import { expect, test } from '@playwright/test';
import { computed } from '../../support/css.js';
import { fixtures, mockApi } from '../../support/mock-api.js';

const REF = 'feature/rework-the-loyalty-points-ledger-so-that-expired-points-are-swept-nightly-4';

for (const width of [700, 1440]) {
  test(`the long ref is cut visually, whole for readers and on hover (${String(width)} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const detail = fixtures.repoLongList();
    await mockApi(page, { repos: [detail.repo], details: [detail] });
    await page.goto('/#/change/104');
    const crumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    const branch = crumb.locator('[aria-current="page"] .branch').first();
    await expect(branch).toHaveText(REF);
    await expect(branch).toHaveAttribute('title', REF);
    expect(await computed(branch, 'text-overflow')).toBe('ellipsis');
    expect(await branch.evaluate((element: unknown) => {
      const box = element as { scrollWidth: number; clientWidth: number };
      return box.scrollWidth > box.clientWidth;
    })).toBe(true);
    await expect(crumb.getByRole('link', { name: detail.repo.name })).toHaveAttribute('title', detail.repo.name);
    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible();
  });
}
