// e2e/fleet/lot-size-order (SPEC.md section 6, ADR-022): one lot per repo, in
// the list order; a larger lot for more unreviewed changes (side ∝
// √(unreviewed + 1), within limits); every lot is "never audited" in phase 2,
// with the legend.

import { expect, test, type Page } from '@playwright/test';
import { computed, resolveColour } from '../../support/css.js';
import { fixtures, mockApi } from '../../support/mock-api.js';

async function lotWidth(page: Page, id: number): Promise<number> {
  const box = await page.locator(`[data-testid="lot"][data-repo-id="${String(id)}"] .top`).boundingBox();
  if (!box) throw new Error(`lot ${String(id)} is not rendered`);
  return box.width;
}

test('one lot per repo, sized by unreviewed changes', async ({ page }) => {
  await mockApi(page, { repos: fixtures.fleetIndicators() });
  await page.goto('/#/');
  const lots = page.getByTestId('lot');
  await expect(lots).toHaveCount(4);
  expect(await lots.evaluateAll((all: { getAttribute(name: string): string | null }[]) => all.map((lot) => lot.getAttribute('data-repo-id')))).toEqual(['11', '12', '13', '14']);

  // unreviewed: 11 → 8, 13 → 2, 12 → 1, 14 → 0
  const [eight, two, one, zero] = await Promise.all([lotWidth(page, 11), lotWidth(page, 13), lotWidth(page, 12), lotWidth(page, 14)]);
  expect(eight).toBeGreaterThan(two);
  expect(two).toBeGreaterThan(one);
  expect(one).toBeGreaterThan(zero);
  // √(8 + 1) / √(0 + 1) = 3
  expect(eight / zero).toBeCloseTo(3, 1);
});

test('every lot is never audited in phase 2, and the legend says so', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  await expect(page.getByTestId('lot')).toHaveCount(3);
  for (const lot of await page.getByTestId('lot').all()) await expect(lot).toHaveAttribute('data-age', 'never');

  // The lot edge and the legend swatch are drawn in --audit-never.
  const never = await resolveColour(page, 'var(--audit-never)');
  const edge = await computed(page.locator('[data-testid="lot"][data-repo-id="1"] .edge'), 'stroke');
  expect(edge).toBe(await resolveColour(page, `color-mix(in srgb, ${never} 80%, transparent)`));
  expect(await computed(page.locator('[data-testid="fleet-legend"] [data-age="never"] i'), 'background-color')).toBe(never);

  const legend = page.getByTestId('fleet-legend');
  await expect(legend).toContainText('Last audit');
  await expect(legend).toContainText('never audited');
  await expect(legend).toContainText('size: unreviewed changes');
  await expect(legend).toContainText('dimmed: inactive');
});

test('a lot shows its unreviewed count and name', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/');
  const shop = page.locator('[data-testid="lot"][data-repo-id="1"]');
  await expect(shop.locator('.count')).toHaveText('3');
  await expect(shop.locator('.name')).toHaveText('sample-shop');
});
