// e2e/findings/mark-repaints-in-place (DC-110): "Mark as intended" and its
// Undo change a finding's state and a verdict, never the layout, so the city
// repaints in place: no new ground, lots, path or towers (each made new
// materials, and freeing the old ones first made three compile every shader
// again, seconds on a software renderer). From the click to the first frame
// drawn without the pin takes well under a second; the camera stays.

import { test, type Page } from '@playwright/test';
import { HIGH, intendButton, openFindings, pinsOn, SERVICE, tabCard, undoButton } from '../../support/findings.js';
import { sceneExpect as expect, stats } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

/** The budget from the click to the frame that shows the new state; a rebuild under SwiftShader took several times this. */
const BUDGET_MS = 1000;

/**
 * Watches, in the page, for the first frame drawn once the city's debug state
 * has `want` high pins on the service, after a click on `button`. Resolves to
 * the time from the click to the end of that frame's draw (ms): what the page
 * spends, without the time the GPU process takes to show it, which on a
 * loaded CI runner's SwiftShader says nothing about the screen.
 */
async function clickToFrame(page: Page, button: 'finding-intend' | 'finding-undo', want: number): Promise<number> {
  // A string: the e2e project has no DOM types.
  await page.evaluate(`(() => {
    const scene = window.diffcityScene;
    const watch = { clicked: null, gone: null };
    window.__mark = watch;
    document.addEventListener('click', (event) => {
      if (watch.clicked === null && event.target instanceof Element && event.target.closest('[data-testid="${button}"]') !== null) watch.clicked = performance.now();
    }, { capture: true });
    let shownAt = null;
    const tick = () => {
      if (watch.clicked !== null) {
        const pins = scene.effects().markers.filter((m) => m.kind === 'pin' && m.file === ${JSON.stringify(SERVICE)} && m.severity === 'high').length;
        const frames = scene.stats().frames;
        // The state is there; the next frame drawn after it shows it.
        if (shownAt === null && pins === ${String(want)}) shownAt = frames;
        else if (shownAt !== null && frames > shownAt) {
          watch.gone = performance.now();
          return;
        }
      }
      setTimeout(tick, 4);
    };
    tick();
  })()`);
  const card = tabCard(page, HIGH);
  await (button === 'finding-intend' ? intendButton(card) : undoButton(card)).click();
  await expect.poll(() => page.evaluate<number | null>('window.__mark.gone'), { timeout: 30_000 }).not.toBeNull();
  return page.evaluate<number>('window.__mark.gone - window.__mark.clicked');
}

test('findings/mark-repaints-in-place', async ({ page }) => {
  await openFindings(page);
  await page.getByTestId('tab-findings').click();
  await expect.poll(() => pinsOn(page, SERVICE)).toContain('high');
  // Measure once the first frames and the quality probe are done, and a few
  // frames after it: the level it picks frees the composer's two render
  // targets, which the next frames allocate again, one each.
  await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.quality().settled'), { timeout: 60_000 }).toBe(true);
  await page.evaluate('window.diffcityScene.bench(300)');
  const before = await stats(page);
  const camera = await page.evaluate('window.diffcityScene.camera()');

  const marked = await clickToFrame(page, 'finding-intend', 0);
  test.info().annotations.push({ type: 'click to frame, mark (ms)', description: marked.toFixed(0) });
  expect(marked).toBeLessThan(BUDGET_MS);
  await expect(tabCard(page, HIGH)).toHaveAttribute('data-state', 'intended');
  const afterMark = await stats(page);
  // Repainted, not rebuilt: the same city, the same towers' buffers (the risky beam went with the verdict).
  expect(afterMark.layouts).toBe(before.layouts);
  expect(afterMark.builds).toBe(before.builds);

  const undone = await clickToFrame(page, 'finding-undo', 1);
  test.info().annotations.push({ type: 'click to frame, undo (ms)', description: undone.toFixed(0) });
  expect(undone).toBeLessThan(BUDGET_MS);
  await expect(tabCard(page, HIGH)).toHaveAttribute('data-state', 'open');
  const afterUndo = await stats(page);
  expect(afterUndo.layouts).toBe(before.layouts);
  expect(afterUndo.builds).toBe(before.builds);
  expect(await page.evaluate('window.diffcityScene.camera()')).toEqual(camera);
});
