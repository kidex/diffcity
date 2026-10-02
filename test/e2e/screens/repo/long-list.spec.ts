// e2e/repo/long-list (SPEC.md sections 3a and 6): a repo with 44 changes,
// every kind crossed with every review state, long titles, long refs and a
// long base, renders every row, filters with AND on the whole list, and fits
// the window at 700, 1024 and 1440 px in both themes: no horizontal scroll,
// and the header actions keep the page gutter when the header wraps.

import { expect, test, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { shownChangeIds } from '../../support/repo.js';

const WIDTHS = [700, 1024, 1440] as const;
const THEMES = ['dark', 'light'] as const;
/** The page gutter of the Repo screen (title, chips, rows). */
const GUTTER = 22;

async function open(page: Page): Promise<void> {
  await mockApi(page, { details: [fixtures.repoLongList()] });
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(44);
}

test('every change is listed in the API order, with its kind, review state and stats', async ({ page }) => {
  await open(page);
  const detail = fixtures.repoLongList();
  expect(await shownChangeIds(page)).toEqual(detail.changes.map((change) => String(change.id)));
  await expect(page.getByTestId('change-count')).toHaveText('44');
  await expect(page.getByTestId('head-not-fetched')).toHaveCount(detail.changes.filter((change) => !change.headAvailable).length);
  await expect(page.getByTestId('computing')).toHaveCount(detail.changes.filter((change) => change.headAvailable && change.stats === null).length);
  await expect(page.getByTestId('agent-badge')).toHaveCount(detail.changes.filter((change) => change.agentUnreviewed).length);
  await expect(page.getByTestId('dirty')).toHaveCount(detail.changes.filter((change) => change.dirty).length);

  const long = page.locator('[data-testid="change-row"][data-change-id="104"]');
  await expect(long.getByTestId('ref')).toHaveText('feature/rework-the-loyalty-points-ledger-so-that-expired-points-are-swept-nightly-4');
  await expect(long.getByTestId('change-title')).toContainText('Rework the loyalty points ledger');
  await expect(long.getByTestId('ahead-behind')).toHaveText('28 ahead, 12 behind');
});

test('kind and review state combine with AND on the long list; Show everything resets', async ({ page }) => {
  await open(page);
  const kinds = page.getByRole('group', { name: 'Filter by kind' });
  const reviews = page.getByRole('group', { name: 'Filter by review state' });
  await expect(kinds.getByRole('button')).toHaveText(['Draft 15', 'Branch 15', 'PR 14']);
  await expect(reviews.getByRole('button', { name: /^(Unreviewed|In review|Approved)/ })).toHaveText(['Unreviewed 15', 'In review 15', 'Approved 14']);

  await kinds.getByRole('button', { name: /^PR/ }).click();
  await reviews.getByRole('button', { name: /^Approved/ }).click();
  const expected = fixtures
    .repoLongList()
    .changes.filter((change) => change.kind === 'pr' && change.reviewState === 'approved')
    .map((change) => String(change.id));
  expect(expected).toHaveLength(4);
  await expect(page.getByTestId('change-row')).toHaveCount(4);
  expect(await shownChangeIds(page)).toEqual(expected);
  await expect(page.getByTestId('change-count')).toHaveText('4 of 44');

  await page.getByTestId('show-everything').click();
  await expect(page.getByTestId('change-row')).toHaveCount(44);
});

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`no horizontal scroll at ${String(width)} px, ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const { scroll, client } = await page.evaluate<{ scroll: number; client: number }>(
        '({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })',
      );
      expect(scroll).toBe(client);
      for (const row of await page.getByTestId('change-row').all()) {
        const box = await row.boundingBox();
        expect(box && box.x + box.width).toBeLessThanOrEqual(width);
      }
    });

    test(`the header actions keep the page gutter at ${String(width)} px, ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      for (const target of [page.getByTestId('archive-toggle'), page.getByTestId('audit-now')]) {
        const box = await target.boundingBox();
        if (!box) throw new Error('header action not rendered');
        expect(box.x).toBeGreaterThanOrEqual(GUTTER);
        expect(box.x + box.width).toBeLessThanOrEqual(width - GUTTER);
      }
    });
  }
}
