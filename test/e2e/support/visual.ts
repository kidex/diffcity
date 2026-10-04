// Shared pieces of the visual baselines (change/visual-*, DC-92): the screen
// at 1600x1000 under reduced motion and the dark scheme, from the golden
// Report served by the mock API, compared with `toHaveScreenshot` at a pixel
// ratio of 0.01.
//
// The baselines are rendered on Linux CI (headless Chromium on SwiftShader);
// other platforms rasterise text and WebGL differently, so the specs skip
// there. DIFFCITY_VISUAL=any runs them anyway, to try a spec on a developer
// machine: the images it writes carry that platform's name and are not the
// baselines.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForCity, waitReady } from './scene.js';

export const VISUAL_VIEWPORT = { width: 1600, height: 1000 };

/**
 * The scene's quality ladder is picked by a frame-rate probe, which makes the
 * look depend on the machine's speed. The hook's `scene-quality` holds level 0
 * (full: MSAA 4x, bloom at half resolution, glass with the environment map)
 * and skips the probe.
 */
export const VISUAL_QUERY = '?scene-debug&scene-quality=0';

/** Skips every test of the file outside Linux CI. Call at the top of a spec file. */
export function linuxOnly(): void {
  test.skip(
    process.platform !== 'linux' && process.env['DIFFCITY_VISUAL'] !== 'any',
    'visual baselines are rendered on Linux CI (SwiftShader); this platform rasterises differently',
  );
}

/** Reduced motion, dark scheme, 1600x1000: call before `page.goto`. */
export async function prepareVisual(page: Page): Promise<void> {
  await page.setViewportSize(VISUAL_VIEWPORT);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
}

/** Opens change 11 with the quality held, and waits for the city's first frame. */
export async function openVisualCity(page: Page): Promise<void> {
  await page.goto(`/${VISUAL_QUERY}#/change/11`);
  await waitReady(page);
  await settle(page);
}

/** Opens change 11 without WebGL (the fallback list). */
export async function openVisualList(page: Page): Promise<void> {
  await page.goto('/#/change/11');
  await expect(page.getByTestId('no-webgl-note')).toBeVisible();
  await expect(page.getByTestId('touched-file').first()).toBeVisible();
}

/** Lets the roof labels re-rank once the camera rests (120 ms after the last move). */
export async function settle(page: Page): Promise<void> {
  await waitForCity(page);
  await expect(page.getByTestId('roof-label').first()).toBeVisible();
  await page.waitForTimeout(400);
}

/** What changes with the clock: the breadcrumb's "N days ago". */
export const relativeTimes = (page: Page): Locator[] => [page.getByRole('navigation', { name: 'Breadcrumb' })];

/** The screenshot options every baseline shares. */
export const shot = (page: Page): { mask: Locator[]; maxDiffPixelRatio: number; timeout: number; animations: 'disabled'; caret: 'hide' } => ({
  mask: relativeTimes(page),
  maxDiffPixelRatio: 0.01,
  // Two identical frames in a row, each a software-rasterised page: well beyond the 5 s default.
  timeout: 45_000,
  animations: 'disabled',
  caret: 'hide',
});
