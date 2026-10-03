// e2e/fileview/highlight-classes (ADR-027): the daemon's `hl` ranges become
// spans whose classes map to the ten --code-* tokens, and a row's text stays
// exactly what the file says, markup included: it is built as text nodes.

import { test } from '@playwright/test';
import type { HighlightClass } from '../../../../src/core/model/types.js';
import { GUARD } from '../../support/hud.js';
import { sceneExpect as expect } from '../../support/scene.js';
import type { Line } from '../../support/fileview.js';
import { diffView, fileDiff, openDiff, rowsOf } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

const CLASSES: HighlightClass[] = ['kw', 'str', 'num', 'com', 'type', 'fn', 'prop', 'op', 'punc', 'var'];
const HOSTILE = '<img src=x onerror="window.__owned = 1"> & </span><b>';

/** The computed colour of an element coloured with `var(--code-<cls>)`. */
const tokenColor = (cls: string): string =>
  `(() => { const probe = document.createElement('i'); probe.style.color = 'var(--code-${cls})'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`;

test('fileview/highlight-classes', async ({ page }) => {
  // One row per class, each highlighted over the word "word"; then a row of hostile text with a range over it.
  const script: Line[] = CLASSES.map((cls): Line => ['add', `x word ${cls}`, [[2, 6, cls]]]);
  script.push(['add', HOSTILE, [[0, 4, 'punc']]]);
  const rows = rowsOf(script);
  await openDiff(page, ({ path }) => fileDiff({ path, rows }), { file: GUARD });
  await expect(diffView(page)).toHaveAttribute('data-state', 'text');

  for (const [index, cls] of CLASSES.entries()) {
    const row = page.locator(`[data-row="${String(index)}"]`);
    const span = row.locator(`.hl-${cls}`);
    await expect(span).toHaveText('word');
    await expect(span).toHaveCSS('color', await page.evaluate<string>(tokenColor(cls)));
    // The row's text is unchanged by the spans around it.
    await expect(row.getByTestId('diff-text')).toHaveText(`x word ${cls}`);
  }

  // Repository text is never markup.
  const hostile = page.locator(`[data-row="${String(CLASSES.length)}"]`);
  await expect(hostile.getByTestId('diff-text')).toHaveText(HOSTILE);
  await expect(diffView(page).locator('img, b')).toHaveCount(0);
  expect(await page.evaluate<unknown>('window.__owned')).toBeUndefined();
});
