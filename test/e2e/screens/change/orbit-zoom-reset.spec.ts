// e2e/change/orbit-zoom-reset (design/mockup.html): drag orbits, the wheel
// zooms within limits, R resets the view; hover shows the pointer, click
// selects with the violet outline and Escape clears the selection.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { camera, hovered, openCity, project, selected } from '../../support/scene.js';

test('change/orbit-zoom-reset', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);
  const home = await camera(page);
  const canvas = page.getByTestId('city-canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('no canvas');
  const corner = { x: box.x + 40, y: box.y + box.height - 40 };

  // Drag from an empty corner: theta and phi move; no selection.
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 100, corner.y - 40, { steps: 5 });
  await page.mouse.up();
  const dragged = await camera(page);
  expect(dragged.theta).toBeCloseTo(home.theta - 100 * 0.006, 5);
  expect(dragged.phi).toBeGreaterThan(home.phi);
  expect(await selected(page)).toBeNull();

  // Wheel: in, then far out until the limit.
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await camera(page)).r).toBeLessThan(home.r);
  for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await camera(page)).r).toBeCloseTo((home.r * 48) / 30, 3);

  await page.keyboard.press('r');
  await expect.poll(() => camera(page)).toEqual(home);

  // Hover and select.
  const guard = await project(page, 'src/auth/order.guard.ts');
  await page.mouse.move(guard.x, guard.y);
  await expect.poll(() => hovered(page)).toBe('src/auth/order.guard.ts');
  await expect(canvas).toHaveCSS('cursor', 'pointer');
  await expect(page.locator('.roof.is-hover')).toHaveAttribute('data-building', 'src/auth/order.guard.ts');
  await page.mouse.click(guard.x, guard.y);
  await expect.poll(() => selected(page)).toBe('src/auth/order.guard.ts');
  await expect(page.locator('.roof.is-selected')).toHaveAttribute('data-building', 'src/auth/order.guard.ts');
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toBeNull();
  await expect(page.locator('.roof.is-selected')).toHaveCount(0);
  await page.mouse.move(corner.x, corner.y);
  await expect.poll(() => hovered(page)).toBeNull();
});
