// e2e/a11y/reduced-motion-nothing-animates (DC-89): one spec for every
// animated element of the change screen under prefers-reduced-motion: no
// camera intro, no tween on a live update, no instant-to-animated R reset, no
// pulse (a static glow with a halo strip), no packets on the path, no tier 1
// breathing, no CSS transition or animation anywhere in the page (tooltip,
// toast, labels, cards), and the scene draws on demand only. A control run
// without the preference shows the same page does animate, so the sweep means
// something.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { effects, effectsReport, framesIn } from '../../support/effects.js';
import { GUARD } from '../../support/hud.js';
import { mockApi } from '../../support/mock-api.js';
import { camera, firstCamera, openCity, project, sceneExpect as expect, waitForCityAttribute } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 120_000 });

const NEW_FILE = 'src/repo/orders.audit.ts';

/** Every element whose computed style transitions or animates for a non-zero time, and the running Web Animations. */
const SWEEP = `(() => {
  const moving = [];
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    const transitions = style.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
    const animations = style.animationName !== 'none' && style.animationDuration.split(',').some((d) => parseFloat(d) > 0);
    if (transitions || animations) moving.push(el.tagName.toLowerCase() + '.' + String(el.className));
  }
  return { moving, running: document.getAnimations().length };
})()`;

interface Sweep {
  moving: string[];
  running: number;
}

function withNewFile(): Report {
  const next = effectsReport();
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
  return next;
}

test('a11y/reduced-motion-nothing-animates', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reports: Record<number, Report> = { 11: effectsReport() };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  // No intro: the first frame is the home view, and nothing moves it afterwards.
  const first = await firstCamera(page);
  expect(await camera(page)).toEqual(first);
  await page.waitForTimeout(1800);
  expect(await camera(page)).toEqual(first);

  // No pulse, no packets, no breathing: a static glow with a halo strip, a still path, a ring at full opacity.
  const state = await effects(page);
  expect(state.mode).toBe('static');
  expect(state.pulsing).toBeGreaterThan(0);
  expect(state.halos).toBe(state.pulsing);
  expect(state.path?.tube).toBe(true);
  expect(state.path?.animated).toBe(false);
  expect(state.tier.ring).toBe(true);
  expect(state.tier.opacity).toBe(1);
  expect(state.continuous).toBe(false);

  // Hover and a selection draw a frame and stop: a tooltip and the card appear without a transition.
  const point = await project(page, GUARD);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByTestId('tooltip')).toHaveCSS('opacity', '1');
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);

  // R is a jump, not a move: the camera is home the moment the key is handled.
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await camera(page)).r).not.toBe(first.r);
  await page.keyboard.press('r');
  expect(await camera(page)).toEqual(first);

  // A live update does not tween: the new building stands at its whole height at once.
  reports[11] = withNewFile();
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '3f2a9c4' });
  await expect.poll(() => page.evaluate<boolean>(`Boolean(window.diffcityScene.shown()['${NEW_FILE}'])`)).toBe(true);
  expect(await page.evaluate<boolean>('window.diffcityScene.tweening()')).toBe(false);
  expect(await page.evaluate<unknown>('window.diffcityScene.tweenTrace()')).toBeNull();
  const built = (await page.evaluate<Record<string, { height: number }>>('window.diffcityScene.shown()'))[NEW_FILE];
  expect(built?.height).toBeCloseTo(3 * 0.56 - 0.06, 5);

  // No CSS motion anywhere: not a transition, not an animation, nothing running.
  const sweep = await page.evaluate<Sweep>(SWEEP);
  expect(sweep.moving).toEqual([]);
  expect(sweep.running).toBe(0);

  // On demand only: once the labels have settled, no frame is drawn while nothing changes.
  await expect.poll(() => framesIn(page, 1500), { timeout: 30_000 }).toBe(0);
  expect((await effects(page)).continuous).toBe(false);
});

test('a11y/reduced-motion-nothing-animates: the control run animates without the preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockApi(page, { reports: { 11: effectsReport() } });
  await openCity(page);
  const state = await effects(page);
  expect(state.mode).toBe('animated');
  expect(state.path?.animated).toBe(true);
  expect(state.continuous).toBe(true);
  const sweep = await page.evaluate<Sweep>(SWEEP);
  expect(sweep.moving.length).toBeGreaterThan(0);
});
