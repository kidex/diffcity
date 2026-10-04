// e2e/a11y/tab-order-reaches-filters-tabs-panel (DC-89): with Tab alone a
// keyboard user reaches the summary button, every filter chip, every tab of
// the panel and the stop cards; Enter on a card opens the file view, whose
// back button, mark buttons and diff controls are reached with Tab too. Every
// stop has a visible focus ring: a solid outline in the --sig token colour.

import { test } from '@playwright/test';
import { serveGuard } from '../../support/fileview.js';
import { focused, names, tabUntil, type Focus } from '../../support/a11y.js';
import { openReview } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 120_000 });


function expectRing(stop: Focus): void {
  const where = stop.testid ?? stop.label ?? stop.text;
  expect(stop.focusVisible, `${where} shows :focus-visible`).toBe(true);
  expect(stop.ring.style, `${where} outline style`).toBe('solid');
  expect(stop.ring.width, `${where} outline width`).toBeGreaterThanOrEqual(2);
  expect(stop.ring.color, `${where} outline colour is --sig`).toBe(stop.sig);
}

test('a11y/tab-order-reaches-filters-tabs-panel', async ({ page }) => {
  await openReview(page, { api: { diff: serveGuard() } });

  const chips = await page.evaluate<string[]>(`[...document.querySelectorAll('.hud .chips button')].map((node) => node.getAttribute('data-testid'))`);
  expect(chips.length).toBeGreaterThanOrEqual(10);
  const wanted = [
    'review-summary',
    ...chips,
    'tab-order',
    'tab-findings',
    'tab-outside',
    'tab-symbols',
  ];
  // The five stop cards come after the tabs.
  let cards = 0;
  const stops = await tabUntil(page, (seen) => {
    cards = seen.filter((stop) => stop.testid === 'stop-card').length;
    const got = new Set(names(seen));
    return cards >= 5 && wanted.every((name) => got.has(name));
  });
  const got = new Set(names(stops));
  for (const name of wanted) expect(got.has(name), `Tab reaches ${name}`).toBe(true);
  expect(cards).toBeGreaterThanOrEqual(5);
  for (const stop of stops) expectRing(stop);

  // The order is the screen's: the bar, then the filters, then the tabs, then the cards.
  const order = names(stops);
  expect(order.indexOf('review-summary')).toBeLessThan(order.indexOf('filter-verdict-eyes'));
  expect(order.indexOf('filter-clear')).toBeLessThan(order.indexOf('tab-order'));
  expect(order.indexOf('tab-symbols')).toBeLessThan(order.indexOf('stop-card'));

  // Enter on the focused card opens the file view; its controls are in the tab order.
  await page.getByTestId('stop-card').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('file-view')).toBeVisible();
  await expect(page.getByTestId('diff-row').first()).toBeVisible();
  await page.getByTestId('file-view-back').focus();
  expectRing((await focused(page)) as Focus);
  const inView = await tabUntil(
    page,
    (seen) => {
      const got = new Set(names(seen));
      return ['mark-checked', 'mark-good', 'mark-rewrite', 'hunk-prev', 'hunk-next', 'diff-viewport'].every((name) => got.has(name));
    },
    60,
  );
  const reached = new Set(names(inView));
  for (const name of ['mark-checked', 'mark-good', 'mark-rewrite', 'hunk-prev', 'hunk-next', 'diff-viewport']) {
    expect(reached.has(name), `Tab reaches ${name} in the file view`).toBe(true);
  }
  for (const stop of inView) expectRing(stop);

  // And back with Shift+Tab: the back button is the first control of the view.
  await page.getByTestId('file-view-review').getByTestId('mark-checked').focus();
  const back: (string | null | undefined)[] = [];
  for (let i = 0; i < 6 && back.at(-1) !== 'file-view-back'; i += 1) {
    await page.keyboard.press('Shift+Tab');
    back.push((await focused(page))?.testid);
  }
  expect(back.at(-1)).toBe('file-view-back');
  // Enter on it returns to the tabs.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('file-view')).toBeHidden();
});
