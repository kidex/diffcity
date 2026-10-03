// e2e/change/live-update-new-building-rises (ADR-026): on a live update the
// buildings in both Reports move to their new place over 400 ms, a new
// building rises from the ground, and the camera, the selection and the
// filters stay. The tween is traced by the scene's debug hook (the height the
// new building had on each frame), never timed, because SwiftShader frames are
// slow. The scene keeps its draw-call budget and asks for no more frames
// when the tween ends.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { setTabVisible } from '../../support/effects.js';
import { GUARD } from '../../support/hud.js';
import { camera, openCity, project, selected, stats, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

interface Trace {
  id: string;
  heights: number[];
}

const NEW_FILE = 'src/repo/orders.audit.ts';

test('change/live-update-new-building-rises', async ({ page }, testInfo) => {
  // Motion on: this is the one scene spec that plays the tween.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const reports: Record<number, Report> = { 11: fixtures.reportGolden() };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  // The intro camera runs 1.4 s; let it finish so the camera is the one to keep.
  await expect.poll(async () => (await camera(page)).r, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2000);

  const guard = await project(page, GUARD);
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Reviewed, fine/ }).click();
  const before = await camera(page);
  const heightsBefore = await page.evaluate<Record<string, { x: number; z: number; height: number }>>('window.diffcityScene.shown()');
  expect(heightsBefore[NEW_FILE]).toBeUndefined();

  const next = fixtures.reportGolden();
  const repo = next.packages.find((pkg) => pkg.path === 'src/repo');
  if (repo === undefined) throw new Error('src/repo missing');
  repo.files.push({
    id: NEW_FILE,
    path: NEW_FILE,
    language: 'typescript',
    status: 'add',
    verdict: 'ok',
    inSpec: null,
    symbols: ['audit', 'record', 'flush'].map((name, i) => ({ id: `${NEW_FILE}#${name}`, name, kind: 'function' as const, status: 'add' as const, range: { start: 1 + i * 6, end: 5 + i * 6 } })),
  });
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });

  // The tween ran: the new building's height on each frame starts at the ground, never falls, and ends whole.
  await expect.poll(() => page.evaluate<Trace | null>('window.diffcityScene.tweenTrace()')).not.toBeNull();
  await expect.poll(async () => (await page.evaluate<boolean>('window.diffcityScene.tweening()')), { timeout: 30_000 }).toBe(false);
  const trace = await page.evaluate<Trace | null>('window.diffcityScene.tweenTrace()');
  if (trace === null) throw new Error('no tween trace');
  expect(trace.id).toBe(NEW_FILE);
  expect(trace.heights.length).toBeGreaterThanOrEqual(2);
  const final = (await page.evaluate<Record<string, { x: number; z: number; height: number }>>('window.diffcityScene.shown()'))[NEW_FILE];
  if (final === undefined) throw new Error('the new building is not in the city');
  expect(trace.heights[0]).toBeLessThan(final.height * 0.05);
  expect(trace.heights.at(-1)).toBeCloseTo(final.height, 5);
  for (let i = 1; i < trace.heights.length; i += 1) expect(trace.heights[i]).toBeGreaterThanOrEqual(trace.heights[i - 1] ?? 0);
  expect(final.height).toBeCloseTo(3 * 0.56 - 0.06, 5);

  // Camera, selection and filters stay; the budget holds; the buildings are all there.
  expect(await camera(page)).toEqual(before);
  expect(await selected(page)).toBe(GUARD);
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=ok;type=;rule=');
  const scene = await stats(page);
  expect(scene.buildings).toBe(18);
  expect(scene.drawCalls).toBeLessThanOrEqual(40);

  // The tween asked for no more frames once it ended: with the tab hidden (the golden Report's pulse and tier 1 breathing would otherwise keep the loop running), no frame is drawn once the labels have settled.
  await setTabVisible(page, false);
  await expect
    .poll(
      async () => {
        const frames = (await stats(page)).frames;
        await page.waitForTimeout(1500);
        return (await stats(page)).frames - frames;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
});
