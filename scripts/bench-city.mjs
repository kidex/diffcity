#!/usr/bin/env node
// Headed frame-rate bench of the change screen's city (ADR-026, DC-90). Not
// run in CI: CI renders on SwiftShader, which says nothing about a GPU and
// enforces the draw-call, triangle and idle budgets instead. This one runs on
// a real machine, with its GPU, and prints what the phase report quotes.
//
//   npm run build:standalone          # the page the bench opens (once, and after UI changes)
//   node scripts/bench-city.mjs [golden] [large] [huge] [--runs 3] [--ms 5000] [--quality 0-3] [--uncapped] [--headless]
//
// Without a preset name it runs all three: `golden` (the mockup's change, 17
// files), `large` (2,000 files, about 20,000 floors, 300 touched) and `huge`
// (8,000 files, a stress run), the last two made by
// test/fixtures/ui/gen-large-city.mjs into .tmp/bench/.
//
// Browser: an installed Google Chrome (`channel: 'chrome'`) when there is one,
// else Playwright's Chromium, headed either way (`--headless` is for a smoke
// run of the script itself). The page is a 1600 x 1000 CSS pixel canvas at
// deviceScaleFactor 2 (a 3200 x 2000 drawing buffer), the animations on, the
// hook `window.diffcityScene.bench(ms)` rendering every frame. After the
// first frame the 500 ms quality probe picks the quality level once; the bench
// starts when it has finished, then runs bench(ms) `--runs` times and prints:
// - median fps and the 95th percentile frame time, from the frame intervals
//   (requestAnimationFrame) of all the runs;
// - the hook's own average fps per run;
// - stats(): draw calls, triangles, labels, buildings, floors, GPU memory;
// - the quality level the probe picked.
// `--quality N` skips the probe and holds level N (0 full ... 3 lowest), to measure
// what each fallback buys.
// `--uncapped` lifts the display's 60 Hz cap (no vsync, no frame-rate limit) to show
// the headroom: the fps then is what the GPU can draw, not what the screen shows.
// The numbers depend on the machine and on what else it is doing: close other
// windows, plug it in, and run it twice.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(root, '.tmp', 'standalone');
const BENCH_DIR = join(root, '.tmp', 'bench');
const EMPTY_REPORT = '<script type="application/json" id="diffcity-report"></script>';
const CANVAS = { width: 1600, height: 1000 };

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const RUNS = option('runs', 3);
const MS = option('ms', 5000);
const forced = args.includes('--quality') ? option('quality', 0) : undefined;
const presets = args.filter((arg, i) => !arg.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && /^\d+$/.test(arg)));
const wanted = presets.length === 0 ? ['golden', 'large', 'huge'] : presets;
for (const name of wanted) if (!['golden', 'large', 'huge'].includes(name)) throw new Error(`unknown preset ${name}: use golden, large or huge`);

if (!existsSync(join(BUILD, 'index.html'))) throw new Error('.tmp/standalone is not built: run `npm run build:standalone`');
mkdirSync(BENCH_DIR, { recursive: true });

/** The Report of a preset: the golden scenario's, or a generated city. */
function reportPath(name) {
  if (name === 'golden') return join(root, 'test', 'fixtures', 'scenarios', 'order-discounts', 'expected.json');
  const out = join(BENCH_DIR, `report-${name}.json`);
  const made = spawnSync(process.execPath, [join(root, 'test', 'fixtures', 'ui', 'gen-large-city.mjs'), '--preset', name, '--out', out], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`gen-large-city failed:\n${made.stderr}`);
  return out;
}

/** A copy of the standalone page with the Report embedded, beside the bundle so the asset paths work. */
function pageFor(name) {
  const html = readFileSync(join(BUILD, 'index.html'), 'utf8');
  if (!html.includes(EMPTY_REPORT)) throw new Error('the standalone index.html has no empty report element');
  const text = readFileSync(reportPath(name), 'utf8').replaceAll('<', '\\u003c');
  const file = join(BUILD, `bench-${name}.html`);
  writeFileSync(file, html.replace(EMPTY_REPORT, () => `<script type="application/json" id="diffcity-report">${text}</script>`));
  return file;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)];
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

const launchOptions = {
  headless: flag('headless'),
  args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', ...(flag('uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])],
};
let browser;
let browserName;
try {
  browser = await chromium.launch({ ...launchOptions, channel: 'chrome' });
  browserName = 'Google Chrome';
} catch {
  browser = await chromium.launch(launchOptions);
  browserName = 'Playwright Chromium';
}

const results = [];
try {
  for (const name of wanted) {
    const file = pageFor(name);
    const context = await browser.newContext({ viewport: { width: CANVAS.width, height: CANVAS.height + 120 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.goto(`${pathToFileURL(file).href}?scene-debug${forced === undefined ? '' : `&scene-quality=${String(forced)}`}`);
    await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true', null, { timeout: 180_000 });
    // The canvas is what is 1600 x 1000: make the window as tall (and wide) as the page around it needs.
    for (let i = 0; i < 12; i += 1) {
      const box = await page.locator('[data-testid="city-canvas"]').boundingBox();
      const view = page.viewportSize();
      if (box === null || view === null) break;
      if (Math.abs(box.width - CANVAS.width) < 1 && Math.abs(box.height - CANVAS.height) < 1) break;
      await page.setViewportSize({ width: view.width + Math.round((CANVAS.width - box.width) * 1.2), height: view.height + Math.round(CANVAS.height - box.height) });
      await page.waitForTimeout(300);
    }
    const box = await page.locator('[data-testid="city-canvas"]').boundingBox();
    await page.waitForFunction('window.diffcityScene.quality().settled === true', null, { timeout: 180_000 });
    await page.waitForFunction('window.diffcityScene.firstCamera() !== null && !window.diffcityScene.tweening()');
    await page.waitForTimeout(2000);

    const intervals = [];
    const hookFps = [];
    for (let run = 0; run < RUNS; run += 1) {
      const recorded = await page.evaluate(async (ms) => {
        const deltas = [];
        let last = null;
        let on = true;
        const tick = (now) => {
          if (last !== null) deltas.push(now - last);
          last = now;
          if (on) globalThis.requestAnimationFrame(tick);
        };
        globalThis.requestAnimationFrame(tick);
        const result = await globalThis.diffcityScene.bench(ms);
        on = false;
        return { deltas, fps: result?.fps ?? 0 };
      }, MS);
      intervals.push(...recorded.deltas);
      hookFps.push(recorded.fps);
    }
    const stats = await page.evaluate('window.diffcityScene.stats()');
    const quality = await page.evaluate('window.diffcityScene.quality()');
    results.push({
      preset: name,
      canvas: box === null ? null : `${String(Math.round(box.width))}x${String(Math.round(box.height))}`,
      medianFps: round(1000 / median(intervals)),
      p95FrameMs: round(percentile(intervals, 95)),
      runFps: hookFps,
      stats,
      quality,
    });
    await context.close();
    rmSync(file, { force: true });
  }
} finally {
  await browser.close();
}

console.log(`\nbench-city: ${browserName}${launchOptions.headless ? ' (headless)' : ' (headed)'}${flag('uncapped') ? ', uncapped' : ''}, deviceScaleFactor 2, ${String(RUNS)} x bench(${String(MS)})\n`);
for (const r of results) {
  const { stats, quality } = r;
  console.log(
    [
      `${r.preset}: canvas ${r.canvas} css`,
      `  median fps       ${String(r.medianFps)}   (hook average per run: ${r.runFps.join(', ')})`,
      `  p95 frame time   ${String(r.p95FrameMs)} ms`,
      `  draw calls       ${String(stats.drawCalls)}`,
      `  triangles        ${String(stats.triangles)}`,
      `  labels           ${String(stats.labels)}`,
      `  buildings/floors ${String(stats.buildings)} / ${String(stats.floors)}`,
      `  gpu memory       ${String(stats.geometries)} geometries, ${String(stats.textures)} textures`,
      `  quality          level ${String(quality.level)} (msaa ${String(quality.msaa)}x, bloom ${quality.bloomScale === 0.5 ? 'half' : 'quarter'}, environment ${quality.environment ? 'on' : 'off'}), probe ${String(quality.fps)} fps\n`,
    ].join('\n'),
  );
}
console.log(JSON.stringify(results));
