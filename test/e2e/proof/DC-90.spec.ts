// Proof video for DC-90 (ADR-026, Q13): the large city (2,000 files, about
// 20,000 floors, 300 touched, 40 packages) holds its budgets. The standalone
// page is opened from file://; a small overlay reads the scene's own numbers
// (draw calls, triangles, labels, the quality level the 500 ms probe picked,
// frames per second) while the camera orbits and the zoom changes. The headless
// browser here draws on SwiftShader, so the frame rate on screen is a CPU's;
// the 60 fps figure is measured headed on a real GPU by scripts/bench-city.mjs.
// Recorded by `npm run proof -- DC-90`.

import { fixtures } from '../support/mock-api.js';
import { criterion, expect, titleCard } from '../support/proof.js';
import { waitReady } from '../support/scene.js';
import { test } from '../support/standalone.js';

const OVERLAY = `(() => {
  const box = document.createElement('pre');
  box.setAttribute('data-testid', 'proof-stats');
  Object.assign(box.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483646', margin: '0', padding: '10px 14px',
    background: 'rgba(12,14,20,0.92)', color: '#ffffff', border: '1px solid #f5b83d', borderRadius: '6px',
    font: '500 15px/1.5 ui-monospace, Menlo, monospace', pointerEvents: 'none',
  });
  document.documentElement.appendChild(box);
  let lastFrames = window.diffcityScene.stats().frames;
  let lastAt = performance.now();
  let fps = 0;
  setInterval(() => {
    const scene = window.diffcityScene.stats();
    const quality = window.diffcityScene.quality();
    const now = performance.now();
    fps = ((scene.frames - lastFrames) * 1000) / (now - lastAt);
    lastFrames = scene.frames;
    lastAt = now;
    box.textContent = [
      'large city: ' + String(scene.buildings) + ' files, ' + String(scene.floors) + ' floors',
      'draw calls  ' + String(scene.drawCalls) + ' / 40',
      'triangles   ' + String(scene.triangles) + ' / 1500000',
      'labels      ' + String(scene.labels) + ' / 120',
      'quality     level ' + String(quality.level) + (quality.settled ? '' : ' (probing)') + ', msaa ' + String(quality.msaa) + 'x',
      'frames/s    ' + fps.toFixed(1),
    ].join('\\n');
  }, 400);
})()`;

test('DC-90 the large city holds its budgets', async ({ page, standalone }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await titleCard(page, 'DC-90: the large city holds its frame budget', [
    '2,000 files, about 20,000 floors, 300 touched, 40 packages.',
    'At most 40 draw calls, 1.5 M triangles and 120 labels, at the quality level chosen once at mount.',
  ]);
  await standalone.open(fixtures.reportLargeCity(), { waitForCity: false });
  await waitReady(page);
  await page.evaluate(OVERLAY);
  await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.quality().settled'), { timeout: 120_000 }).toBe(true);

  const canvas = await page.getByTestId('city-canvas').boundingBox();
  if (canvas === null) throw new Error('no canvas');
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;

  await criterion(page, 'The whole large city, with its budgets on screen', async () => {
    const scene = await page.evaluate<{ drawCalls: number; triangles: number; labels: number }>('window.diffcityScene.stats()');
    expect(scene.drawCalls).toBeLessThanOrEqual(40);
    expect(scene.triangles).toBeLessThanOrEqual(1_500_000);
    expect(scene.labels).toBeLessThanOrEqual(120);
  });

  await criterion(page, 'Orbiting: the budgets hold and the labels stay within 120', async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 260, cy + 40, { steps: 12 });
    await page.mouse.move(cx - 200, cy - 60, { steps: 12 });
    await page.mouse.up();
    const scene = await page.evaluate<{ drawCalls: number; labels: number }>('window.diffcityScene.stats()');
    expect(scene.drawCalls).toBeLessThanOrEqual(40);
    expect(scene.labels).toBeLessThanOrEqual(120);
  });

  await criterion(page, 'Zooming in and back out', async () => {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -260);
    await page.waitForTimeout(800);
    for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, 260);
    const scene = await page.evaluate<{ drawCalls: number; triangles: number }>('window.diffcityScene.stats()');
    expect(scene.drawCalls).toBeLessThanOrEqual(40);
    expect(scene.triangles).toBeLessThanOrEqual(1_500_000);
  });

  await criterion(page, 'Pressing R returns to the home view', async () => {
    await page.keyboard.press('r');
    await page.waitForTimeout(600);
  });
});
