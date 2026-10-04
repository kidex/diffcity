// e2e/review/hide-checked (SPEC.md section 6, "Filters"; ADR-028): the "Hide
// checked" chip hides the files and floors with a current mark, combines with
// the verdict row with AND, leaves outdated marks visible, and "Show
// everything" turns it off.

import { test, type Page } from '@playwright/test';
import { floorIndex } from '../../support/effects.js';
import { CONTROLLER, GUARD, MIGRATION, SERVICE } from '../../support/hud.js';
import { panelReport, sym } from '../../support/panel.js';
import { openReview } from '../../support/review.js';
import { marksFromOverlay } from '../../support/review-api.js';
import { sceneExpect as expect } from '../../support/scene.js';

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
});
