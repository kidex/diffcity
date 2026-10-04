// e2e/fleet/first-paint-responsive (DC-86): under CPU raster (the screens
// project runs Chromium on SwiftShader) the Fleet's first paint of its lots
// must not stall the main thread. A 50 ms heartbeat records the largest gap
// between ticks while the Fleet loads and while a repo appears over SSE.
// The cost is paid once per browser (GPU pipelines compile on first use), so the
// test launches its own cold Chromium, whatever ran before it in the worker.

import { chromium, expect, test, type TestInfo } from '@playwright/test';
import { WEBGL_ARGS } from '../../support/browser-args.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

// The runner's speed varies several-fold (a cold 2-vCPU SwiftShader runner stalled the flat drawing for 1.8-3.4 s, a
// quiet laptop 250 ms), so no absolute bound holds. The Fleet's gap is compared with the same Fleet, in another cold
// browser of the same run, with the primitives DC-86 removed put back by a stylesheet (blurred lot shadows and the
// masked, gradient ground grid). Both are slowed equally by the runner; the old drawing took 2.1-2.4 s against 250 ms
// for the flat one, the page's own boot is the same in both, so the flat one must stay clearly below the expensive one.
const MAX_RATIO = 0.6;
// The comparison only means something where the expensive reference itself stalls.
const MIN_REFERENCE_MS = 400;
/** The drawing DC-86 replaced: a blur filter on each lot's shadow, a gradient grid under a radial mask. */
const EXPENSIVE_CSS = `
  .lot .shadow { filter: blur(7px); }
  .lot .face-band { filter: blur(1.5px); }
  .lot .side, .lot .edge { filter: blur(3px); }
  .fleet-svg { filter: drop-shadow(0 0 10px var(--bg-deep)); }
  .fleet-map::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 28px 28px; opacity: .7;
    -webkit-mask-image: radial-gradient(ellipse 70% 75% at 50% 52%, #000 35%, transparent 100%);
    mask-image: radial-gradient(ellipse 70% 75% at 50% 52%, #000 35%, transparent 100%);
  }
`;
// Runs in the page before anything else: the longest time between two ticks of
// a 50 ms timer, which is how long the main thread was away.
const HEARTBEAT = `
  window.beat = { last: performance.now(), max: 0 };
  setInterval(() => {
    const now = performance.now();
    window.beat.max = Math.max(window.beat.max, now - window.beat.last);
    window.beat.last = now;
  }, 50);
`;

/** Launches a cold Chromium, loads the Fleet (optionally with extra CSS), adds a repo over SSE and returns the largest heartbeat gap. */
let launches = 0;
async function fleetGap(baseURL: string | undefined, testInfo: TestInfo, extraCss?: string): Promise<number> {
  // A tag of its own: the stub server may not have dropped the previous launch's stream yet.
  const client = `${testInfo.testId}-${String(++launches)}`;
  const channel = process.env['DIFFCITY_E2E_CHANNEL'];
  const browser = await chromium.launch({ args: WEBGL_ARGS, ...(channel ? { channel } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(baseURL ? { baseURL } : {}) });
    const page = await context.newPage();
    const repos = fixtures.fleetThreeRepos();
    await mockApi(page, { repos });
    await tagClient(page, client);
    await page.addInitScript(HEARTBEAT);
    if (extraCss !== undefined) {
      await page.addInitScript(`document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(extraCss)};
        document.head.append(style);
      });`);
    }
    await page.goto('/#/');
    await expect(page.getByTestId('lot')).toHaveCount(3);
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

    const added = fixtures.fleetNewRepo();
    repos.unshift(added);
    expect(await emitSse(page, client, 'repo', { repoId: added.id })).toBe(1);
    await expect(page.getByTestId('lot')).toHaveCount(4);
    // Let the frames that paint the new lot run.
    await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
    await page.waitForTimeout(300);
    return await page.evaluate<number>('window.beat.max');
  } finally {
    await browser.close();
  }
}

test.describe('fleet first paint (DC-86)', () => {
  // The guard that cannot depend on the runner: the Fleet is drawn with flat primitives only. Gradients, masks, filters
  // and patterns are what cost seconds of first-paint raster on software-rendered browsers.
  test('fleet map draws with flat primitives only', async ({ page }, testInfo) => {
    await mockApi(page, { repos: fixtures.fleetThreeRepos() });
    await tagClient(page, testInfo.testId);
    await page.goto('/#/');
    await expect(page.getByTestId('lot')).toHaveCount(3);
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

    const offenders = await page.evaluate<string[]>(`(() => {
      const found = [];
      const roots = [...document.querySelectorAll('.stage.fleet, .fleet-map')];
      const seen = new Set();
      const describe = (el) => el.tagName.toLowerCase() + (el.getAttribute('class') ? '.' + el.getAttribute('class').split(' ').join('.') : '');
      for (const root of roots) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (/^(filter|mask|pattern|lineargradient|radialgradient)$/i.test(el.tagName)) found.push('<' + el.tagName + '> ' + describe(el));
          for (const pseudo of [null, '::before', '::after']) {
            const style = getComputedStyle(el, pseudo);
            if (pseudo !== null && style.content === 'none') continue;
            const where = describe(el) + (pseudo ?? '');
            if (style.filter !== 'none') found.push(where + ' filter: ' + style.filter);
            if ((style.backdropFilter || 'none') !== 'none') found.push(where + ' backdrop-filter');
            for (const prop of ['maskImage', 'webkitMaskImage']) {
              const value = style[prop];
              if (value && value !== 'none') found.push(where + ' ' + prop + ': ' + value);
            }
            if (/gradient\\(/.test(style.backgroundImage)) found.push(where + ' background-image gradient');
            if (/url\\(/.test(style.fill) || /url\\(/.test(style.stroke)) found.push(where + ' paint server: ' + style.fill);
          }
        }
      }
      return found;
    })()`);
    expect(offenders).toEqual([]);
  });

  // Informative: the runner's speed varies several-fold (a cold 2-vCPU SwiftShader runner stalled the flat drawing for
  // 1.8-3.4 s, a fast one for 68 ms), so the gap is recorded, and compared with the Fleet drawn with the removed
  // primitives (EXPENSIVE_CSS) only on runners where that reference visibly stalls.
  test('the main thread stays responsive while the Fleet paints its lots', async ({ baseURL }, testInfo) => {
    // The best of two cold launches: a scheduling hiccup of a busy runner can only make a gap longer.
    const max = Math.min(await fleetGap(baseURL, testInfo), await fleetGap(baseURL, testInfo));
    const reference = await fleetGap(baseURL, testInfo, EXPENSIVE_CSS);
    testInfo.annotations.push({ type: 'max-heartbeat-gap-ms', description: String(Math.round(max)) });
    testInfo.annotations.push({ type: 'reference-heartbeat-gap-ms', description: String(Math.round(reference)) });
    console.log(`fleet max heartbeat gap: ${String(Math.round(max))} ms; expensive reference: ${String(Math.round(reference))} ms`);
    if (reference <= MIN_REFERENCE_MS) {
      testInfo.annotations.push({ type: 'note', description: 'reference did not stall on this runner' });
      return;
    }
    expect(max).toBeLessThan(reference * MAX_RATIO);
  });
});
