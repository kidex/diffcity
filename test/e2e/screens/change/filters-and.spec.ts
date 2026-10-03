// e2e/change/filters-and (ADR-026): the verdict and type rows combine with
// AND. On the golden Report only the migration is both "needs your eyes" and
// has an added floor; the guard is eyes with no added floor, and the other
// buildings with added floors are reviewed fine.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { MIGRATION, floorStatuses, paintDump } from '../../support/hud.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/filters-and', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = fixtures.reportGolden();
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  await page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Needs your eyes/ }).click();
  await page.getByRole('group', { name: 'Filter by change type' }).getByRole('button', { name: /^Added/ }).click();
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=eyes;type=add;rule=');

  const files = report.packages.flatMap((pkg) => pkg.files);
  const statuses = floorStatuses(report);
  const lit = files.filter((file) => file.verdict === 'eyes' && statuses.get(file.id)?.includes('add')).map((file) => file.id);
  expect(lit).toEqual([MIGRATION]);
  const dimmed = (await paintDump(page)).dimmed;
  await expect.poll(async () => (await paintDump(page)).dimmed.length).toBe(files.length - 1);
  expect(dimmed.length).toBe(files.length - 1);
  // The guard passes the verdict row but not the type row; an added-floor building of another verdict passes the type row but not the verdict row.
  expect((await paintDump(page)).dimmed).toContain('src/auth/order.guard.ts');
  expect((await paintDump(page)).dimmed).toContain('src/services/orders/orders.service.ts');
  expect((await paintDump(page)).dimmed).not.toContain(MIGRATION);
});
