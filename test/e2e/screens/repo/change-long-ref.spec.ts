// e2e/repo/change-long-ref (SPEC.md section 6): `#/change/:id` for a branch
// with a long title, a long ref and a long base fits the window at 700 and
// 1440 px: no horizontal scroll, and the top bar keeps Search and the daemon
// indicator on screen.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

for (const width of [700, 1440]) {
  test(`a long ref fits the change page at ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const detail = fixtures.repoLongList();
    await mockApi(page, { repos: [detail.repo], details: [detail] });
    await page.goto('/#/change/104');
    await expect(page.getByTestId('change-ref')).toHaveText('feature/rework-the-loyalty-points-ledger-so-that-expired-points-are-swept-nightly-4');

    const { scroll, client } = await page.evaluate<{ scroll: number; client: number }>(
      '({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
    );
    expect(scroll).toBe(client);
    await expect(page.getByTestId('daemon')).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: /Search/ })).toBeInViewport({ ratio: 1 });
  });
}
