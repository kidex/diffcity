// perf/large-city-draw-calls, perf/large-city-triangles, perf/label-cap-120,
// perf/label-priority-eyes-first (ADR-026, DC-90): on the `large` preset
// (2,000 files, about 20,000 floors, 300 touched, 40 packages) the scene holds
// its budgets whatever quality level the probe picked (under SwiftShader it
// picks the lowest): at most 40 draw calls and 1.5 M triangles in the scene
// pass, at most 120 labels in the DOM, labels in ADR-026's priority, and no
// frame at all when idle under reduced motion. One large city for the file.
// The frame rate is recorded as an annotation: SwiftShader says little about
// a real GPU, the headed bench (scripts/bench-city.mjs) measures that.

import { test } from '@playwright/test';
import { openLargeCity, type LargeCity } from '../../support/large-city.js';
import { bench, hovered, selected, stats, sceneExpect as expect } from '../../support/scene.js';
import { framesIn } from '../../support/effects.js';

const DRAW_CALLS = 40;
const TRIANGLES = 1_500_000;
const LABELS = 120;

test.describe.serial('perf/large city budgets', () => {
  let city: LargeCity;

  test.beforeAll(async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    city = await openLargeCity(browser, testInfo, 'reduce');
  });
  test.afterAll(async () => {
    await city.close();
  });

  test('perf/large-city-draw-calls', async () => {
    test.setTimeout(180_000);
    const testInfo = test.info();
    const { page } = city;
    const scene = await stats(page);
    expect(scene.buildings).toBe(2000);
    expect(scene.floors).toBeGreaterThan(19_000);
    expect(scene.drawCalls).toBeGreaterThan(0);
    expect(scene.drawCalls).toBeLessThanOrEqual(DRAW_CALLS);

    // No frame while idle under reduced motion, the probe over and the labels settled.
    await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.quality().settled'), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => framesIn(page, 1500), { timeout: 60_000 }).toBe(0);

    const measured = await bench(page, 1500);
    expect(measured.drawCalls).toBeGreaterThan(0);
    expect(measured.drawCalls).toBeLessThanOrEqual(DRAW_CALLS);
    testInfo.annotations.push({ type: 'bench', description: `large: ${String(measured.drawCalls)} draw calls, ${String(measured.fps)} fps` });
  });

  test('perf/large-city-triangles', async () => {
    const { page } = city;
    const scene = await stats(page);
    expect(scene.triangles).toBeGreaterThan(0);
    expect(scene.triangles).toBeLessThanOrEqual(TRIANGLES);
    await bench(page, 500);
    expect((await stats(page)).triangles).toBeLessThanOrEqual(TRIANGLES);
  });

  test('perf/label-cap-120', async () => {
    const { page } = city;
    const scene = await stats(page);
    expect(scene.labels).toBeGreaterThan(0);
    expect(scene.labels).toBeLessThanOrEqual(LABELS);
    await expect.poll(() => page.getByTestId('roof-label').count()).toBeLessThanOrEqual(LABELS);
    expect(await page.getByTestId('roof-label').count()).toBe(scene.labels);

    // Hover and selection change the set, never its size.
    const target = await pointOn(city, (file) => file.status !== 'same' && file.verdict === 'ok');
    await page.mouse.click(target.x, target.y);
    await expect.poll(() => selected(page)).toBe(target.id);
    expect(await page.getByTestId('roof-label').count()).toBeLessThanOrEqual(LABELS);
    await page.keyboard.press('Escape');
    await expect.poll(() => selected(page)).toBeNull();
    expect(await page.getByTestId('roof-label').count()).toBeLessThanOrEqual(LABELS);
  });

  test('perf/label-priority-eyes-first', async () => {
    const { page, report } = city;
    const files = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same');
    const urgent = files.filter((file) => file.verdict === 'eyes' || file.verdict === 'risky');
    const others = files.filter((file) => file.verdict !== 'eyes' && file.verdict !== 'risky');
    // The preset has more eyes and risky files than labels, and other touched files that never get one.
    expect(urgent.length).toBeGreaterThan(LABELS);
    expect(others.length).toBeGreaterThan(50);

    // The pointer of the previous test is still over a building: nothing is hovered here.
    await page.mouse.move(2, 2);
    await expect.poll(() => hovered(page)).toBeNull();
    const verdictOf = (id: string): string | undefined => files.find((file) => file.id === id)?.verdict;
    const labelled = (): Promise<string[]> =>
      page.evaluate<string[]>(`[...document.querySelectorAll('[data-testid="roof-label"]')].map((node) => node.getAttribute('data-building') ?? '')`);
    await expect.poll(async () => (await labelled()).length).toBe(LABELS);
    // Untouched files never get a label; eyes and risky come before any other touched file.
    for (const id of await labelled()) expect(['eyes', 'risky']).toContain(verdictOf(id));

    // A hovered file comes first whatever its verdict: it is labelled, and an eyes or risky label gives way.
    const target = await pointOn(city, (file) => file.status !== 'same' && file.verdict === 'ok');
    expect(await hovered(page)).toBe(target.id);
    await expect.poll(async () => (await labelled()).includes(target.id)).toBe(true);
    const after = await labelled();
    expect(after).toHaveLength(LABELS);
    expect(after.filter((id) => !['eyes', 'risky'].includes(verdictOf(id) ?? '')).sort()).toEqual([target.id]);
    await expect(page.locator(`[data-testid="roof-label"][data-building="${target.id}"]`)).toHaveClass(/is-hover/);

    // The pointer leaves: back to eyes and risky only.
    await page.mouse.move(2, 2);
    await expect.poll(() => hovered(page)).toBeNull();
    await expect.poll(async () => (await labelled()).includes(target.id)).toBe(false);
  });
});

/** Moves the pointer onto the first file (in Report order) that `want` accepts and the camera shows unobstructed; returns its id and the point. */
async function pointOn(city: LargeCity, want: (file: LargeCity['report']['packages'][number]['files'][number]) => boolean): Promise<{ id: string; x: number; y: number }> {
  const { page, report } = city;
  const candidates = report.packages.flatMap((pkg) => pkg.files).filter(want);
  const canvas = await page.getByTestId('city-canvas').boundingBox();
  if (canvas === null) throw new Error('no canvas');
  for (const file of candidates.slice(0, 120)) {
    const point = await page.evaluate<{ x: number; y: number } | null>(`window.diffcityScene.project(${JSON.stringify(file.id)})`);
    if (point === null || point.x < canvas.x + 20 || point.x > canvas.x + canvas.width - 20 || point.y < canvas.y + 80 || point.y > canvas.y + canvas.height - 20) continue;
    await page.mouse.move(point.x, point.y);
    if ((await hovered(page)) === file.id) return { id: file.id, x: point.x, y: point.y };
  }
  throw new Error('no file of the large city can be pointed at');
}
