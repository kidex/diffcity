// Screenshots of the three directions: a hero view after the intro move and
// a view with a building hovered. Needs `npm run design:directions` running.
//
//   node design/directions/shoot.mjs [a b c]
//
// DIRECTIONS_URL overrides the server (default http://127.0.0.1:4400);
// DIRECTIONS_CHANNEL picks an installed browser (default: chrome).

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'screenshots');
const base = process.env.DIRECTIONS_URL ?? 'http://127.0.0.1:4400';
const channel = process.env.DIRECTIONS_CHANNEL ?? 'chrome';
const which = process.argv.slice(2);
const directions = which.length > 0 ? which : ['a', 'b', 'c'];
/** The building hovered in the second shot: the tallest changed tower. */
const HOVER = 'src/services/orders/orders.service.ts';

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  for (const id of directions) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
    });
    await page.goto(`${base}/${id}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => 'diffcityDirections' in window);
    await page.waitForTimeout(3200);
    await page.screenshot({ path: join(out, `${id}-hero.png`) });
    const spot = await page.evaluate((building) => window.diffcityDirections.hover(building), HOVER);
    if (spot !== null) {
      await page.mouse.move(spot.x - 40, spot.y - 40);
      await page.mouse.move(spot.x, spot.y, { steps: 4 });
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: join(out, `${id}-hover.png`) });
    const fps = await page.evaluate(() => window.diffcityDirections.bench(3000));
    console.log(`${id}: screenshots saved, ${String(fps)} fps while rendering every frame${errors.length > 0 ? `, console: ${errors.join(' | ')}` : ''}`);
    await page.close();
  }
} finally {
  await browser.close();
}
