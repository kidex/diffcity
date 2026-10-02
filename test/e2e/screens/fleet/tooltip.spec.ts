// e2e/fleet/tooltip: the hover card is anchored to the lot under the pointer
// or the keyboard focus, never covers that lot or its labels, stays inside
// the map, and follows live updates of the repo it describes.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (!found) throw new Error('not rendered');
  return found;
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const tip = (page: Page) => page.locator('.fleet-map .tip');

/** The card is shown for `lot`, clear of the lot and its labels, and inside the map. */
async function expectClear(page: Page, lot: Locator): Promise<void> {
  await expect(tip(page)).toHaveClass(/show/);
  // Wait out the card's 120 ms entrance (it rises 4 px).
  await expect(tip(page)).toHaveCSS('opacity', '1');
  const card = await box(tip(page));
  for (const part of ['.top', '.side', '.name', '.sub']) {
    expect(overlaps(card, await box(lot.locator(part))), part).toBe(false);
  }
  const map = await box(page.locator('.fleet-map'));
  expect(card.x).toBeGreaterThanOrEqual(map.x);
  expect(card.x + card.width).toBeLessThanOrEqual(map.x + map.width);
  expect(card.y).toBeGreaterThanOrEqual(map.y);
  expect(card.y + card.height).toBeLessThanOrEqual(map.y + map.height);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 700, height: 900 },
]) {
  test(`the card never covers the hovered lot or its labels (${String(viewport.width)} px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockApi(page, { repos: fixtures.fleetIndicators() });
    await page.goto('/#/');
    const lots = page.getByTestId('lot');
    await expect(lots).toHaveCount(4);
    for (const lot of await lots.all()) {
      await lot.hover();
      await expectClear(page, lot);
      // The card does not move with the pointer inside the lot.
      const before = await box(tip(page));
      const face = await box(lot.locator('.top'));
      await page.mouse.move(face.x + 4, face.y + face.height - 4);
      expect(await box(tip(page))).toEqual(before);
    }
  });
}

test('keyboard focus shows the same anchored card', async ({ page }) => {
  await mockApi(page, { repos: fixtures.fleetIndicators() });
  await page.goto('/#/');
  const lot = page.locator('[data-testid="lot"][data-repo-id="12"]');
  await lot.focus();
  await expect(tip(page)).toContainText('media-pipeline');
  await expectClear(page, lot);
  await page.keyboard.press('Tab');
  await expect(tip(page)).toContainText('status-page');
  await expectClear(page, page.locator('[data-testid="lot"][data-repo-id="13"]'));
});

test('the card follows a live update of the hovered repo', async ({ page }, testInfo) => {
  const repos = fixtures.fleetThreeRepos();
  await mockApi(page, { repos });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await page.locator('[data-testid="lot"][data-repo-id="1"]').hover();
  await expect(tip(page)).toContainText('1 draft');

  const [shop] = repos;
  if (!shop) throw new Error('fleet-three-repos.json is empty');
  repos[0] = { ...shop, counts: { draft: 3, branch: 2, pr: 1 }, path: '/work/sample-shop-moved' };
  await emitSse(page, testInfo.testId, 'repo', { repoId: shop.id });
  await expect(tip(page)).toContainText('3 draft');
  await expect(tip(page)).toContainText('/work/sample-shop-moved');
  await expect(tip(page)).toHaveClass(/show/);
});
