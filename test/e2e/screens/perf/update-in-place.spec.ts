// perf/update-in-place-same-count (ADR-026, DC-79, DC-90): on the `large`
// preset, a live update that keeps the number of instances the towers need
// (two files change places, a floor changes status) lays the new frame out in
// the buffers that are there: no tower build, no new geometry or texture on
// the GPU. A Report with another number of buildings is the control: it
// builds anew. One large city for the file.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { openLargeCity, type LargeCity } from '../../support/large-city.js';
import { stats, sceneExpect as expect } from '../../support/scene.js';

let city: LargeCity;

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  city = await openLargeCity(browser, testInfo, 'reduce');
});
test.afterAll(async () => {
  await city.close();
});

/** Stats once the GPU's holdings stop changing: textures and geometries are uploaded by the frames that draw them. */
async function steadyStats(): Promise<Awaited<ReturnType<typeof stats>>> {
  let last = await stats(city.page);
  await expect
    .poll(
      async () => {
        await city.page.waitForTimeout(1200);
        const next = await stats(city.page);
        const same = next.geometries === last.geometries && next.textures === last.textures && next.frames === last.frames;
        last = next;
        return same;
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  return last;
}

const shownOf = (id: string): Promise<{ x: number; z: number; height: number } | undefined> =>
  city.page.evaluate<{ x: number; z: number; height: number } | undefined>(`window.diffcityScene.shown()[${JSON.stringify(id)}]`);

test('perf/update-in-place-same-count', async () => {
  test.setTimeout(240_000);
  const { page } = city;
  await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.tweening()'), { timeout: 60_000 }).toBe(false);
  // The quality probe replaces render targets once; measure after it.
  await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.quality().settled'), { timeout: 60_000 }).toBe(true);
  const before = await steadyStats();
  expect(before.frames).toBeGreaterThan(0);
  expect(before.buildings).toBe(2000);

  // Same files and floors; two files of the first package with several files swap places, and one changed floor goes from mod to add.
  const next: Report = structuredClone(city.report);
  const pkg = next.packages.find((candidate) => candidate.files.length >= 3);
  if (pkg === undefined) throw new Error('no package with three files');
  const [first] = pkg.files;
  if (first === undefined) throw new Error('empty package');
  const moved = await shownOf(first.id);
  pkg.files.reverse();
  const changed = next.packages.flatMap((candidate) => candidate.files).find((file) => file.symbols.some((symbol) => symbol.status === 'mod'));
  const floor = changed?.symbols.find((symbol) => symbol.status === 'mod');
  if (floor === undefined) throw new Error('no modified floor');
  floor.status = 'add';

  await city.push(next);
  await expect.poll(async () => (await shownOf(first.id))?.x !== moved?.x || (await shownOf(first.id))?.z !== moved?.z).toBe(true);
  await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.tweening()')).toBe(false);
  // The GPU only holds what a frame drew: wait for the frames after the update to be done.
  await expect.poll(async () => (await stats(page)).frames, { timeout: 60_000 }).toBeGreaterThan(before.frames);
  const after = await steadyStats();
  expect(after.buildings).toBe(before.buildings);
  expect(after.floors).toBe(before.floors);
  expect(after.builds).toBe(before.builds);
  expect(after.geometries).toBe(before.geometries);
  expect(after.drawCalls).toBeLessThanOrEqual(40);

  // Another update changes nothing on the GPU either: no texture or geometry piles up. (The first update draws one texture
  // that the first frame had not needed yet, so textures are compared between the two updates.)
  pkg.files.reverse();
  await city.push(next);
  await expect.poll(async () => (await stats(page)).frames, { timeout: 60_000 }).toBeGreaterThan(after.frames);
  const again = await steadyStats();
  expect(again.builds).toBe(before.builds);
  expect(again.geometries).toBe(before.geometries);
  expect(again.textures).toBe(after.textures);

  // Control: one building fewer needs other buffers.
  const fewer: Report = structuredClone(city.report);
  const last = fewer.packages.at(-1);
  last?.files.pop();
  await city.push(fewer);
  await expect.poll(async () => (await stats(page)).buildings).toBe(1999);
  expect((await stats(page)).builds).toBe(before.builds + 1);
});
