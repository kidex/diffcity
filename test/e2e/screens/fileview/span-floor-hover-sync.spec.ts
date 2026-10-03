// e2e/fileview/span-floor-hover-sync (ADR-027): the pointer on the lines of a
// symbol lights that symbol's floor in the city, and the pointer on a floor
// lights the symbol's lines in the diff.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { hoveredFloor, project, sceneExpect as expect, waitForCityAttribute } from '../../support/scene.js';
import { CAN_PLACE } from '../../support/panel.js';
import { diffRows, openDiff, serveGuard } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

test('fileview/span-floor-hover-sync', async ({ page }) => {
  await openDiff(page, serveGuard());
  const city = page.getByTestId('city');
  const lit = (row: number) => page.locator(`[data-row="${String(row)}"]`);

  // The symbol's lines have an edge; none is lit while the pointer is elsewhere.
  await expect(lit(23)).toHaveClass(/\bsym\b/);
  await expect(diffRows(page).and(page.locator('.hot'))).toHaveCount(0);
  await expect.poll(() => hoveredFloor(page)).toBeNull();

  // Span -> floor: the pointer on a line of canPlace lights its floor and the building, and all the symbol's lines.
  await lit(23).hover();
  await expect.poll(() => hoveredFloor(page)).toBe(CAN_PLACE);
  await waitForCityAttribute(page, 'data-hovered', GUARD);
  await expect(city).toHaveAttribute('data-hovered-floor', CAN_PLACE);
  for (const row of [21, 22, 23, 24]) await expect(lit(row)).toHaveClass(/\bhot\b/);
  await expect(lit(25)).not.toHaveClass(/\bhot\b/);

  // Leaving the diff puts it out.
  await page.mouse.move(5, 5);
  await expect.poll(() => hoveredFloor(page)).toBeNull();
  await waitForCityAttribute(page, 'data-hovered', '');
  await expect(diffRows(page).and(page.locator('.hot'))).toHaveCount(0);

  // Floor -> span: the pointer on the floor lights the symbol's lines in the diff.
  const floor = await project(page, GUARD, CAN_PLACE);
  await page.mouse.move(floor.x, floor.y);
  await expect(lit(22)).toHaveClass(/\bhot\b/);
  await expect(lit(24)).toHaveClass(/\bhot\b/);
  await expect(lit(25)).not.toHaveClass(/\bhot\b/);
  // The diff did not echo it back to the city.
  await expect.poll(() => hoveredFloor(page)).toBeNull();

  // Off the building: the lines go out.
  await page.mouse.move(5, 5);
  await expect(diffRows(page).and(page.locator('.hot'))).toHaveCount(0);
});
