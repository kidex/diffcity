// e2e/repo/row-card (DC-57): each change row is a card whose title is its
// most prominent text, with kind and review state as solid badges, the
// verdicts asking for a look as loud coloured tiles and the others muted; the
// layout keeps the 22 px gutter at 700, 1024 and 1440 px without horizontal
// scroll; the closed-changes toggle works from the keyboard.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { computed } from '../../support/css.js';
import { mockApi } from '../../support/mock-api.js';

const HINT = 'Merged, deleted, closed or cleaned changes, kept for 90 days';
const GUTTER = 22;

const row = (page: Page, id: number): Locator => page.locator(`[data-testid="change-row"][data-change-id="${String(id)}"]`);

async function openRepo(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
}

const style = computed;

interface Box {
  x: number;
  width: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('element has no box');
  return found;
}

// In-page: every text element of a card, the title and the attention tile
// numerals excepted, with its font size.
const OTHER_TEXT_SIZES = (id: number): string => `(() => {
  const root = document.querySelector('[data-testid="change-row"][data-change-id="${String(id)}"]');
  const sizes = [];
  for (const element of root.querySelectorAll('*')) {
    if (element.closest('[data-testid="change-title"]') || element.closest('.tag.verdict.flag')) continue;
    const own = [...element.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').trim();
    if (!own || element.getClientRects().length === 0) continue;
    sizes.push({ text: own, size: parseFloat(getComputedStyle(element).fontSize) });
  }
  return sizes;
})()`;

// In-page: how far each card's content spills past its own width.
const CARD_OVERFLOW = `[...document.querySelectorAll('[data-testid="change-row"]')].map((e) => e.scrollWidth - e.clientWidth)`;

const fontSize = async (locator: Locator): Promise<number> => parseFloat(await style(locator, 'font-size'));

/** An opaque or tinted fill, not the transparent default. */
const isFilled = (colour: string): boolean => colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent';

test('the title is the most prominent text of the card', async ({ page }) => {
  await openRepo(page);
  const card = row(page, 11);
  const title = card.getByTestId('change-title');
  const titleSize = await fontSize(title);
  expect(parseInt(await style(title, 'font-weight'), 10)).toBeGreaterThanOrEqual(600);
  // Every other text element of the card, verdict count numerals excepted, is smaller.
  const others = await page.evaluate<{ text: string; size: number }[]>(OTHER_TEXT_SIZES(11));
  expect(others.length).toBeGreaterThan(5);
  expect(others.filter((other) => other.size >= titleSize)).toEqual([]);
});

test('kind and review state are solid badges', async ({ page }) => {
  await openRepo(page);
  for (const id of [10, 11, 14, 15]) {
    const card = row(page, id);
    expect(isFilled(await style(card.getByTestId('kind'), 'background-color')), `kind of ${String(id)}`).toBe(true);
    expect(parseInt(await style(card.getByTestId('kind'), 'font-weight'), 10)).toBeGreaterThanOrEqual(600);
    const review = card.getByTestId('review-state');
    const filled = isFilled(await style(review, 'background-color'));
    const outlined = (await style(review, 'box-shadow')) !== 'none';
    expect(filled || outlined, `review state of ${String(id)}`).toBe(true);
    expect(parseInt(await style(review, 'font-weight'), 10)).toBeGreaterThanOrEqual(600);
  }
});

test('attention verdicts are loud tiles, reviewed-fine and untouched are muted', async ({ page }) => {
  await openRepo(page);
  const loud = [row(page, 11).locator('[data-verdict="eyes"]'), row(page, 11).locator('[data-verdict="spec"]'), row(page, 15).locator('[data-verdict="risky"]')];
  const quiet = [row(page, 15).locator('[data-verdict="ok"]'), row(page, 11).locator('[data-verdict="same"]')];
  for (const tile of [...loud, ...quiet]) await expect(tile).toBeVisible();

  for (const tile of loud) {
    await expect(tile).toHaveClass(/\bflag\b/);
    expect(isFilled(await style(tile, 'background-color'))).toBe(true);
    // The count is the biggest numeral on the card.
    expect(await fontSize(tile.locator('b'))).toBeGreaterThan(await fontSize(row(page, 11).getByTestId('change-title')));
  }
  const eyes = row(page, 11).locator('[data-verdict="eyes"]');
  for (const tile of quiet) {
    await expect(tile).toHaveClass(/\bquiet\b/);
    expect(isFilled(await style(tile, 'background-color'))).toBe(false);
    expect(await fontSize(tile)).toBeLessThan(await fontSize(eyes));
    expect(await fontSize(tile.locator('b'))).toBeLessThan(await fontSize(eyes.locator('b')));
  }
  // A zero counter is not drawn at all.
  await expect(row(page, 15).locator('[data-verdict="eyes"]')).toHaveCount(0);
  await expect(row(page, 15).locator('[data-verdict="spec"]')).toHaveCount(0);
});

for (const width of [700, 1024, 1440]) {
  test(`the cards keep the 22 px gutter with no horizontal scroll (${String(width)} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openRepo(page);
    expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    const list = await box(page.getByTestId('change-list'));
    const heading = await box(page.locator('.repo .changes h2'));
    expect(Math.round(heading.x - list.x)).toBe(GUTTER);
    for (const card of await page.getByTestId('change-row').all()) {
      const edges = await box(card);
      expect(Math.round(edges.x - list.x)).toBe(GUTTER);
      expect(Math.round(list.x + list.width - (edges.x + edges.width))).toBe(GUTTER);
      expect(edges.x + edges.width).toBeLessThanOrEqual(width);
    }
    // Nothing inside a card spills past it.
    expect((await page.evaluate<number[]>(CARD_OVERFLOW)).filter((spill) => spill > 0)).toEqual([]);
  });
}

test('the closed-changes toggle works from the keyboard', async ({ page }) => {
  await openRepo(page);
  const toggle = page.getByTestId('archive-toggle');
  const tip = page.getByRole('tooltip', { name: HINT });
  await expect(tip).toBeHidden();

  // Tab from the top of the page until the toggle holds focus.
  await page.locator('body').focus();
  let reached = false;
  for (let step = 0; step < 30 && !reached; step += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate<boolean>(`document.activeElement?.dataset.testid === 'archive-toggle'`);
  }
  expect(reached).toBe(true);
  await expect(toggle).toHaveText('Show closed changes');
  await expect(tip).toBeVisible();
  await expect(tip).toHaveCSS('opacity', '1');

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('change-row')).toHaveCount(4);
  await expect(toggle).toHaveText('Back to open changes');
  await expect(toggle).toBeFocused();
  await expect(page.locator('.repo .changes h2')).toHaveText('Closed changes');
  await expect(page.getByTestId('closed-filters')).toBeVisible();
  await expect(page.getByTestId('open-filters')).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(toggle).toHaveText('Show closed changes');
  await expect(toggle).toBeFocused();
  await expect(page.getByTestId('open-filters')).toBeVisible();
});
