// e2e/findings/mark-repaints-in-place (DC-110): "Mark as intended" and its
// Undo change a finding's state and a verdict, never the layout, so the city
// repaints in place: no new ground, lots, path or towers (each made new
// materials, and freeing the old ones first made three compile every shader
// again, seconds on a software renderer). The hard gate is that nothing is
// built; on top, the scene draws the refetched Report within a second of
// receiving it. The time from the click (mock round trips included) is only
// recorded as an annotation.

import { test, type Page } from '@playwright/test';
import { HIGH, intendButton, openFindings, pinsOn, SERVICE, tabCard, undoButton } from '../../support/findings.js';
import { sceneExpect as expect, stats } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

/** From the scene receiving the Report to the end of the frame that draws it; a rebuild under SwiftShader took about 2.5 s. */
const BUDGET_MS = 1000;

interface SceneUpdate {
  seq: number;
  at: number;
  drawnAt: number | null;
  open: number;
}

const updates = (page: Page): Promise<SceneUpdate[]> => page.evaluate<SceneUpdate[]>('window.diffcityScene.updates()');

/**
 * Clicks `button` on the high finding's card and waits for the scene to draw
 * the first Report after the click with `open` open findings. Returns the
 * times from that Report reaching the scene, and from the click, to the end
 * of the frame that drew it (ms). Both are stamped by the page itself.
 */
async function act(page: Page, button: 'finding-intend' | 'finding-undo', open: number): Promise<{ draw: number; click: number }> {
  const last = (await updates(page)).at(-1)?.seq ?? 0;
  // A string: the e2e project has no DOM types.
  await page.evaluate(`(() => {
    window.__clicked = null;
    document.addEventListener('click', (event) => {
      if (window.__clicked === null && event.target instanceof Element && event.target.closest('[data-testid="${button}"]') !== null) window.__clicked = performance.now();
    }, { capture: true });
  })()`);
  const card = tabCard(page, HIGH);
  await (button === 'finding-intend' ? intendButton(card) : undoButton(card)).click();
  let drawn: SceneUpdate | undefined;
  await expect
    .poll(async () => {
      drawn = (await updates(page)).find((update) => update.seq > last && update.open === open);
      return drawn?.drawnAt ?? null;
    })
    .not.toBeNull();
  const clicked = await page.evaluate<number>('window.__clicked');
  if (drawn?.drawnAt == null) throw new Error('no drawn update');
  return { draw: drawn.drawnAt - drawn.at, click: drawn.drawnAt - clicked };
}

test('findings/mark-repaints-in-place', async ({ page }) => {
  const { reports } = await openFindings(page);
  const open = reports[11]?.findings.filter((finding) => finding.state === 'open').length ?? 0;
  await page.getByTestId('tab-findings').click();
  await expect.poll(() => pinsOn(page, SERVICE)).toContain('high');
  // Measure once the quality probe is done, and a few frames after it: the
  // level it picks frees the composer's two render targets, which the next
  // frames allocate again, one each (slow frames on SwiftShader).
  await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.quality().settled'), { timeout: 60_000 }).toBe(true);
  await page.evaluate('window.diffcityScene.bench(300)');
  const before = await stats(page);
  const camera = await page.evaluate('window.diffcityScene.camera()');

  const marked = await act(page, 'finding-intend', open - 1);
  test.info().annotations.push({ type: 'mark: Report to frame (ms)', description: marked.draw.toFixed(0) }, { type: 'mark: click to frame (ms)', description: marked.click.toFixed(0) });
  await expect(tabCard(page, HIGH)).toHaveAttribute('data-state', 'intended');
  await expect.poll(() => pinsOn(page, SERVICE)).not.toContain('high');
  const afterMark = await stats(page);
  // Repainted, not rebuilt: the same city, the same towers' buffers (the risky beam went with the verdict).
  expect(afterMark.layouts).toBe(before.layouts);
  expect(afterMark.builds).toBe(before.builds);
  expect(marked.draw).toBeLessThan(BUDGET_MS);

  const undone = await act(page, 'finding-undo', open);
  test.info().annotations.push({ type: 'undo: Report to frame (ms)', description: undone.draw.toFixed(0) }, { type: 'undo: click to frame (ms)', description: undone.click.toFixed(0) });
  await expect(tabCard(page, HIGH)).toHaveAttribute('data-state', 'open');
  await expect.poll(() => pinsOn(page, SERVICE)).toContain('high');
  const afterUndo = await stats(page);
  expect(afterUndo.layouts).toBe(before.layouts);
  expect(afterUndo.builds).toBe(before.builds);
  expect(undone.draw).toBeLessThan(BUDGET_MS);
  expect(await page.evaluate('window.diffcityScene.camera()')).toEqual(camera);
});
