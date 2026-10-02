// e2e/fleet/legend-flow: the legend follows the map in the page flow, so
// however many lines it wraps to, it sits below every lot and its labels and
// pushes the repo list down instead of covering anything.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

interface Layout {
  lines: number;
  legendTop: number;
  legendBottom: number;
  lowestLabel: number;
  mapBottom: number;
  listTop: number;
}

const READ = `(() => {
  const legend = document.querySelector('[data-testid="fleet-legend"]');
  const box = legend.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(legend).lineHeight) || 18;
  const labels = [...document.querySelectorAll('[data-testid="lot"] .sub, [data-testid="lot"] .name')];
  return {
    lines: Math.round((box.height - parseFloat(getComputedStyle(legend).paddingBottom)) / line),
    legendTop: box.top,
    legendBottom: box.bottom,
    lowestLabel: Math.max(...labels.map((label) => label.getBoundingClientRect().bottom)),
    mapBottom: document.querySelector('.fleet-map').getBoundingClientRect().bottom,
    listTop: document.querySelector('.fleet-list').getBoundingClientRect().top,
  };
})()`;

for (const width of [360, 480, 760, 1440]) {
  test(`the legend sits below every lot label and above the list (${String(width)} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page, { repos: fixtures.fleetIndicators() });
    await page.goto('/#/');
    await expect(page.getByTestId('lot')).toHaveCount(4);
    await page.evaluate('document.fonts.ready.then(() => undefined)');
    const layout = await page.evaluate<Layout>(READ);
    if (width <= 480) expect(layout.lines, 'the narrow legend wraps to several lines').toBeGreaterThanOrEqual(3);
    expect(layout.legendTop).toBeGreaterThanOrEqual(layout.lowestLabel);
    expect(layout.legendBottom).toBeLessThanOrEqual(layout.mapBottom + 0.5);
    expect(layout.listTop).toBeGreaterThanOrEqual(layout.mapBottom - 0.5);
  });
}
