// e2e/review/hide-checked (SPEC.md section 6, "Filters"; ADR-028): the "Hide
// checked" chip hides the files and floors with a current mark, combines with
// the verdict row with AND, leaves outdated marks visible, and "Show
// everything" turns it off. The filter rows, the chip with them, never run
// into the legend in the city's bottom left corner (DC-139).

import { test, type Page } from '@playwright/test';
import { floorIndex } from '../../support/effects.js';
import { CONTROLLER, GUARD, MIGRATION, SERVICE } from '../../support/hud.js';
import { panelReport, sym } from '../../support/panel.js';
import { openReview, selectFile } from '../../support/review.js';
import { marksFromOverlay } from '../../support/review-api.js';
import { camera, sceneExpect as expect, waitForCityAttribute } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

interface Paint {
  dimmed: string[];
  floors: Record<string, number[]>;
}

const paint = (page: Page): Promise<Paint> => page.evaluate<Paint>('window.diffcityScene.paint()');

test('review/hide-checked', async ({ page }) => {
  const report = panelReport();
  const applyDiscount = sym(SERVICE, 'OrdersService.applyDiscount');
  await openReview(page, {
    report,
    marks: marksFromOverlay(report, {
      // The guard is marked as a whole; the service has one marked floor; the migration's mark went outdated.
      files: { [GUARD]: 'checked', [MIGRATION]: 'outdated' },
      symbols: { [applyDiscount]: 'rewrite' },
    }),
  });
  const chip = page.getByTestId('filter-hide-checked');
  await expect(chip).toHaveText('Hide checked');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  expect((await paint(page)).dimmed).toEqual([]);

  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=;rule=;hide-checked');
  await expect.poll(async () => (await paint(page)).dimmed).toEqual([GUARD]);
  // Floors: the marked floor of the service is hidden, the rest of the service is not; the guard's floors go with the guard.
  const state = await paint(page);
  expect(state.floors[SERVICE]).toEqual([floorIndex(report, SERVICE, 'OrdersService.applyDiscount')]);
  expect(state.floors[GUARD]).toEqual([0, 1, 2]);
  // An outdated mark is not a mark: the migration stays.
  expect(state.dimmed).not.toContain(MIGRATION);
  expect(state.floors[MIGRATION]).toBeUndefined();

  // AND with the verdict row: Reviewed fine dims every other verdict, the guard is hidden anyway.
  await page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Reviewed, fine/ }).click();
  await expect.poll(async () => (await paint(page)).dimmed).toContain(MIGRATION);
  const both = (await paint(page)).dimmed;
  expect(both).toContain(GUARD);
  expect(both).not.toContain(CONTROLLER);
  expect(both).not.toContain(SERVICE);
  // Turn the verdict row off again: only the checked file is hidden.
  await page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Reviewed, fine/ }).click();
  await expect.poll(async () => (await paint(page)).dimmed).toEqual([GUARD]);

  // "Show everything" turns it off too.
  await page.getByTestId('filter-clear').click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await paint(page)).dimmed).toEqual([]);

  // Pressing the chip again and then once more: on, off.
  await chip.click();
  await expect.poll(async () => (await paint(page)).dimmed).toEqual([GUARD]);
  await chip.click();
  await expect.poll(async () => (await paint(page)).dimmed).toEqual([]);

  // DC-139: the legend sits below the filter rows, inside the city, at a small, a medium and the default window.
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const size = `${String(viewport.width)}x${String(viewport.height)}`;
    const [filters, legend, city] = await Promise.all([page.getByTestId('hud-filters').boundingBox(), page.getByTestId('legend').boundingBox(), page.getByTestId('city').boundingBox()]);
    if (filters === null || legend === null || city === null) throw new Error(`${size}: no box for the filters, the legend or the city`);
    const apart = legend.y >= filters.y + filters.height || legend.x >= filters.x + filters.width || legend.x + legend.width <= filters.x || legend.y + legend.height <= filters.y;
    expect(apart, `${size}: filters ${JSON.stringify(filters)}, legend ${JSON.stringify(legend)}`).toBe(true);
    // In view: under the filters in the same column, not pushed out of the city.
    expect(Math.abs(legend.x - filters.x), `${size}: the legend's left edge`).toBeLessThanOrEqual(1);
    expect(legend.y + legend.height, `${size}: the legend inside the city`).toBeLessThanOrEqual(city.y + city.height);
    await expect(page.getByTestId('legend-toggle'), `${size}: the legend is not folded`).toBeHidden();
    // The default window keeps the mockup's place: 22 px from the left, 18 px above the city's bottom edge.
    if (viewport.width === 1440) expect([Math.round(legend.x - city.x), Math.round(city.y + city.height - legend.y - legend.height)]).toEqual([22, 18]);
  }

  // DC-139, every filter row at once: a rule finding adds the Rules row under "Hide checked". At 1024x768,
  // the window of the original bug, the legend still has to be on screen under the filters, not clipped away.
  const withRule = panelReport();
  withRule.findings.push({
    id: 'rule:file-size:5c1e0b77',
    source: 'rule:file-size',
    severity: 'med',
    category: 'architecture',
    file: CONTROLLER,
    line: 1,
    title: 'File is over the size limit',
    message: 'The controller has more lines than the repo allows.',
    state: 'open',
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('about:blank');
  await openReview(page, { report: withRule, marks: marksFromOverlay(withRule, { files: { [GUARD]: 'checked' } }) });
  await expect(page.getByRole('group', { name: 'Filter by rule' })).toBeVisible();
  await expect(page.getByTestId('filter-hide-checked')).toBeVisible();
  const [filters, legend, column] = await Promise.all([page.getByTestId('hud-filters').boundingBox(), page.getByTestId('legend').boundingBox(), page.getByTestId('hud-left').boundingBox()]);
  if (filters === null || legend === null || column === null) throw new Error('1024x768 with rules: no box for the filters, the legend or the column');
  const seen = `filters ${JSON.stringify(filters)}, legend ${JSON.stringify(legend)}, column ${JSON.stringify(column)}`;
  expect(legend.y, `1024x768 with rules, legend under the filters: ${seen}`).toBeGreaterThanOrEqual(filters.y + filters.height);
  expect(legend.x + legend.width, `1024x768 with rules, legend inside the visible column: ${seen}`).toBeLessThanOrEqual(column.x + column.width);
  expect(legend.y + legend.height, `1024x768 with rules, legend inside the visible column: ${seen}`).toBeLessThanOrEqual(column.y + column.height);

  // DC-139, 1024x600: too short for the legend under every row. It folds into a "Legend" chip whose popover
  // holds the whole legend; Esc closes it and gives focus back to the chip, a click elsewhere closes it too.
  await page.setViewportSize({ width: 1024, height: 600 });
  const toggle = page.getByTestId('legend-toggle');
  const legendBox = page.getByTestId('legend');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(legendBox).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog', { name: 'Legend' })).toBeVisible();
  await expect(legendBox).toBeFocused();
  for (const label of ['needs your eyes', 'removed', 'untouched', 'rule violation']) await expect(legendBox).toContainText(label);
  const [pop, chipBox] = await Promise.all([legendBox.boundingBox(), toggle.boundingBox()]);
  if (pop === null || chipBox === null) throw new Error('1024x600: no box for the popover or the chip');
  expect(pop.y + pop.height, '1024x600: the popover opens above the chip').toBeLessThanOrEqual(chipBox.y);
  await page.keyboard.press('Escape');
  await expect(legendBox).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(legendBox).toBeVisible();
  await page.mouse.click(500, 30);
  await expect(legendBox).toBeHidden();
  // Tabbing out of the popover closes it.
  await toggle.click();
  await expect(legendBox).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(legendBox).toBeHidden();
  // Esc with the popover open closes the popover only: the city keeps its selection.
  await page.setViewportSize({ width: 1440, height: 900 });
  await selectFile(page, GUARD);
  await page.setViewportSize({ width: 1024, height: 600 });
  await toggle.click();
  await expect(legendBox).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('city')).toHaveAttribute('data-selected', GUARD);
  // The window grows with the popover open and focused: the legend unfolds and focus goes to the first filter chip.
  await toggle.click();
  await expect(legendBox).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('hud-filters').getByRole('button').first()).toBeFocused();
  await expect(toggle).toBeHidden();
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.keyboard.press('Escape');
  await waitForCityAttribute(page, 'data-selected', '');

  // A drag on the scroll box beside the chips still orbits the city.
  // The column measures again on the next resize observation: wait for the scroll box.
  const empty = await (await page.waitForFunction(`(() => {
    const box = document.querySelector('[data-testid="hud-filters"]');
    if (box === null || !box.classList.contains('scrolls')) return null;
    const r = box.getBoundingClientRect();
    for (let y = r.top + 6; y < r.bottom - 6; y += 4) {
      const x = r.left + box.clientWidth - 12;
      const hit = document.elementFromPoint(x, y);
      if (hit !== null && box.contains(hit) && hit.closest('button') === null) return { x, y };
    }
    return null;
  })()`, null, { timeout: 10_000 })).jsonValue() as { x: number; y: number };
  const before = await camera(page);
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x - 80, empty.y + 10, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await camera(page)).theta).not.toBeCloseTo(before.theta, 3);

  // Every filter chip, "Hide checked" and the Rules row included, can be scrolled into view and clicked:
  // the rows scroll inside the column instead of running under the city's bottom edge.
  const city600 = await page.getByTestId('city').boundingBox();
  if (city600 === null) throw new Error('1024x600: no box for the city');
  const chips = page.getByTestId('hud-filters').getByRole('button');
  const count = await chips.count();
  expect(count).toBeGreaterThanOrEqual(12);
  for (let i = 0; i < count; i += 1) {
    const chip = chips.nth(i);
    await chip.scrollIntoViewIfNeeded();
    await expect(chip).toBeInViewport();
    const box = await chip.boundingBox();
    if (box === null) throw new Error(`1024x600: no box for filter chip ${String(i)}`);
    expect(box.y + box.height, `1024x600: filter chip ${String(i)} above the city's bottom edge`).toBeLessThanOrEqual(city600.y + city600.height);
    await chip.click({ trial: true });
  }
  const rule = page.getByRole('group', { name: 'Filter by rule' }).getByRole('button').first();
  await rule.focus();
  await expect(rule).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(rule).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('filter-hide-checked').click();
  await expect(page.getByTestId('filter-hide-checked')).toHaveAttribute('aria-pressed', 'true');
});
