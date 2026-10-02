// e2e/fleet/many-repos (SPEC.md section 6, ADR-022): with 24 repos and one
// very long name, the Fleet keeps every lot, its labels and the legend apart
// and inside the map, never scrolls the page sideways, and shortens only the
// lot label of the long name (the accessible name and the list keep it whole),
// at the narrow, medium and wide widths.

import { expect, test, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

const LONG = 'an-extremely-long-repository-name-for-the-overflow-check';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Geometry {
  viewport: number;
  scrollWidth: number;
  map: Rect;
  legend: Rect;
  lots: { id: string; whole: Rect; labels: Rect[] }[];
}

/** Boxes of the map, the legend, every lot and its two labels, read in the page. */
function geometry(page: Page): Promise<Geometry> {
  return page.evaluate<Geometry>(`(() => {
    const rect = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
    return {
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      map: rect(document.querySelector('.fleet-svg')),
      legend: rect(document.querySelector('[data-testid="fleet-legend"]')),
      lots: [...document.querySelectorAll('[data-testid="lot"]')].map((lot) => ({
        id: lot.dataset.repoId,
        whole: rect(lot),
        labels: [rect(lot.querySelector('.name')), rect(lot.querySelector('.sub'))],
      })),
    };
  })()`);
}

const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const inside = (a: Rect, outer: Rect): boolean =>
  a.left >= outer.left - 0.5 && a.right <= outer.right + 0.5 && a.top >= outer.top - 0.5 && a.bottom <= outer.bottom + 0.5;

for (const width of [700, 1024, 1440]) {
  test(`24 repos stay apart and inside the map (${String(width)} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page, { repos: fixtures.fleetManyRepos() });
    await page.goto('/#/');
    await expect(page.getByTestId('lot')).toHaveCount(24);
    await expect(page.getByTestId('repo-row')).toHaveCount(24);
    await page.evaluate('document.fonts.ready.then(() => undefined)');

    const g = await geometry(page);
    expect(g.scrollWidth, 'no sideways page scroll').toBeLessThanOrEqual(g.viewport);
    for (const lot of g.lots) {
      expect(inside(lot.whole, g.map), `lot ${lot.id} inside the map`).toBe(true);
      expect(overlaps(lot.whole, g.legend), `lot ${lot.id} clear of the legend`).toBe(false);
    }
    for (let i = 0; i < g.lots.length; i++) {
      for (let j = i + 1; j < g.lots.length; j++) {
        const [a, b] = [g.lots[i], g.lots[j]];
        if (!a || !b) continue;
        expect(overlaps(a.whole, b.whole), `lots ${a.id} and ${b.id} apart`).toBe(false);
        // Labels of a lot also stay clear of every other lot (face and labels).
        for (const label of a.labels) expect(overlaps(label, b.whole), `label of ${a.id} over ${b.id}`).toBe(false);
      }
    }
  });
}

test('a long name is shortened under its lot only', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await mockApi(page, { repos: fixtures.fleetManyRepos() });
  await page.goto('/#/');
  const lot = page.locator('[data-testid="lot"][data-repo-id="123"]');
  await expect(lot.locator('.name')).toHaveText(/^an-extremely-.*…$/);
  await expect(lot).toHaveAttribute('aria-label', new RegExp(`^${LONG}, `));
  const row = page.getByTestId('repo-row').filter({ hasText: LONG });
  await expect(row.getByRole('link', { name: LONG, exact: true })).toBeVisible();
  // The row wraps the name rather than pushing the table wider than the page.
  const fits = await page.evaluate<boolean>(
    `(() => { const t = document.querySelector('.fleet-list table') ?? document.querySelector('.fleet-list'); return t.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5; })()`,
  );
  expect(fits).toBe(true);
  await lot.hover();
  await expect(page.locator('.fleet-map .tip .f')).toHaveText(LONG);
});

test('the keyboard walks all 24 lots in list order, each scrolled into view with its card', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  const repos = fixtures.fleetManyRepos();
  await mockApi(page, { repos });
  await page.goto('/#/');
  await expect(page.getByTestId('lot')).toHaveCount(24);
  await page.getByRole('button', { name: /Search/ }).focus();
  for (const repo of repos) {
    await page.keyboard.press('Tab');
    const lot = page.locator(`[data-testid="lot"][data-repo-id="${String(repo.id)}"]`);
    await expect(lot).toBeFocused();
    await expect(lot).toBeInViewport();
    await expect(page.locator('.fleet-map .tip')).toHaveClass(/show/);
    await expect(page.locator('.fleet-map .tip .f')).toHaveText(repo.name);
  }
  // After the last lot, Tab moves on to the first row of the list.
  await page.keyboard.press('Tab');
  const first = repos[0];
  if (!first) throw new Error('fleet-many-repos.json is empty');
  await expect(page.getByTestId('repo-row').first().getByRole('link', { name: first.name, exact: true })).toBeFocused();
  await expect(page.locator('.fleet-map .tip')).not.toHaveClass(/show/);
});

test('Enter on a lot deep in the map opens its repo', async ({ page }) => {
  await mockApi(page, { repos: fixtures.fleetManyRepos() });
  await page.goto('/#/');
  await page.locator('[data-testid="lot"][data-repo-id="120"]').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/repo\/120$/);
});
