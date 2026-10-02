// e2e/fleet/legend-clear (SPEC.md section 6, ADR-022): the legend under the
// map never covers a lot or its name and sub-labels, at any width, including
// the narrow widths where the legend wraps to more than one line.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

interface Overlap {
  legendTop: number;
  legendHeight: number;
  covered: string[];
}

const READ = `(() => {
  const legend = document.querySelector('[data-testid="fleet-legend"]').getBoundingClientRect();
  const covered = [];
  for (const lot of document.querySelectorAll('[data-testid="lot"]')) {
    for (const part of ['.top', '.name', '.sub']) {
      const b = lot.querySelector(part).getBoundingClientRect();
      if (b.left < legend.right && legend.left < b.right && b.top < legend.bottom && legend.top < b.bottom) {
        covered.push(lot.dataset.repoId + ' ' + part);
      }
    }
  }
  return { legendTop: legend.top, legendHeight: legend.height, covered };
})()`;

for (const [label, repos] of [
  ['three repos', fixtures.fleetThreeRepos],
  ['indicators', fixtures.fleetIndicators],
] as const) {
  for (const width of [600, 700, 1024, 1440]) {
    test(`the legend covers no lot label (${label}, ${String(width)} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page, { repos: repos() });
      await page.goto('/#/');
      await expect(page.getByTestId('lot')).not.toHaveCount(0);
      await page.evaluate('document.fonts.ready.then(() => undefined)');
      const result = await page.evaluate<Overlap>(READ);
      expect(result.covered, `legend ${String(Math.round(result.legendHeight))} px tall`).toEqual([]);
    });
  }
}
