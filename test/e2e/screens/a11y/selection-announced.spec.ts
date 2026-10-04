// e2e/a11y/selection-announced (DC-89): the selection is announced through a
// polite live region, "Selected <path>, <verdict label>, tier 1", whether it
// comes from a click in the city, a key or the panel; nothing is announced for
// a cleared selection, and the card is not a second live region.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { openPanel, panelReport } from '../../support/panel.js';
import { project, selected, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

const LABEL = { eyes: 'Needs your eyes', risky: 'Risky', spec: 'Outside the spec', ok: 'Reviewed, fine', same: 'Unchanged' } as const;

test('a11y/selection-announced', async ({ page }) => {
  const report = panelReport();
  const files = report.packages.flatMap((pkg) => pkg.files.map((file) => ({ file, tier1: pkg.tier1 })));
  await openPanel(page, report);
  const live = page.getByTestId('selection-live');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveText('');
  await expect(page.getByTestId('selection-card')).not.toHaveAttribute('aria-live', /.*/);

  // A click on the guard, the spec's own example.
  const point = await project(page, GUARD);
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(live).toHaveText('Selected src/auth/order.guard.ts, Needs your eyes, tier 1');

  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toBeNull();

  // Every file announces what the Report says of it: its verdict label, and tier 1 only in a tier 1 package.
  const seen = new Set<string>();
  for (const { file, tier1 } of files.filter(({ file: f }) => f.status !== 'same')) {
    await page.keyboard.press(']');
    await expect.poll(() => selected(page)).toBe(file.id);
    const expected = `Selected ${file.path}, ${LABEL[file.verdict]}${tier1 ? ', tier 1' : ''}`;
    await expect(live).toHaveText(expected);
    seen.add(`${file.verdict}/${String(tier1)}`);
  }
  // The walk covered a tier 1 file and one that is not, and more than one verdict.
  expect(seen.has('eyes/true')).toBe(true);
  expect([...seen].some((key) => key.endsWith('/false'))).toBe(true);
  expect(new Set([...seen].map((key) => key.split('/')[0])).size).toBeGreaterThan(1);

  // Cleared: nothing to announce.
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toBeNull();
  await expect(live).toHaveText('');
});
