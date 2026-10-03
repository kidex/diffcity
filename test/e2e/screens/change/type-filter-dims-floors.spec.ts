// e2e/change/type-filter-dims-floors (ADR-026): row 2 has a chip per change
// type with its counter from the summary; choosing one dims the floors of the
// other types and the buildings with no floor of that type.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { floorStatuses, paintDump } from '../../support/hud.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/type-filter-dims-floors', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = fixtures.reportGolden();
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  const row = page.getByRole('group', { name: 'Filter by change type' });
  const { byStatus } = report.summary;
  await expect(row.getByRole('button', { name: /^Added/ })).toHaveText(`Added${String(byStatus.add)}`);
  await expect(row.getByRole('button', { name: /^Modified/ })).toHaveText(`Modified${String(byStatus.mod)}`);
  await expect(row.getByRole('button', { name: /^Signature changed/ })).toHaveText(`Signature changed${String(byStatus.sig)}`);
  await expect(row.getByRole('button', { name: /^Removed/ })).toHaveText(`Removed${String(byStatus.del)}`);
  await expect(row.getByRole('button', { name: 'Show everything' })).toBeVisible();

  const statuses = floorStatuses(report);
  for (const [name, status] of [
    ['Added', 'add'],
    ['Removed', 'del'],
  ] as const) {
    const chip = row.getByRole('button', { name: new RegExp(`^${name}`) });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    const expectedBuildings = [...statuses].filter(([, floors]) => !floors.includes(status)).map(([id]) => id);
    const expectedFloors: Record<string, number[]> = {};
    for (const [id, floors] of statuses) {
      if (!floors.includes(status)) continue;
      const dim = floors.flatMap((floor, i) => (floor === status ? [] : [i]));
      if (dim.length > 0) expectedFloors[id] = dim;
    }
    await expect.poll(async () => (await paintDump(page)).dimmed.sort()).toEqual(expectedBuildings.sort());
    expect((await paintDump(page)).floors).toEqual({
      ...expectedFloors,
      // A dimmed building's floors are all dimmed with it.
      ...Object.fromEntries(expectedBuildings.map((id) => [id, (statuses.get(id) ?? []).map((_, i) => i)])),
    });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  }
  await expect.poll(async () => (await paintDump(page)).dimmed).toEqual([]);
});
