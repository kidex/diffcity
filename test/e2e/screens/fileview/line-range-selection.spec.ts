// e2e/fileview/line-range-selection (ADR-028): a click on a line number picks
// that line on its side, Shift+click extends the range, and the range is kept
// as { side, start, end } for the review marks. No mark is drawn here.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { diffView, openDiff, serveGuard } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

test('fileview/line-range-selection', async ({ page }) => {
  await openDiff(page, serveGuard());
  const view = diffView(page);
  const row = (index: number) => page.locator(`[data-row="${String(index)}"]`);
  await expect(view).toHaveAttribute('data-range', '');

  // A click on the old number of the removed row (old line 23).
  await row(22).getByTestId('diff-old').click();
  await expect(view).toHaveAttribute('data-range', 'old 23');
  await expect(row(22)).toHaveClass(/\bpicked\b/);

  // Shift+click on the old number of row 25 (old line 24) extends it.
  await row(25).getByTestId('diff-old').click({ modifiers: ['Shift'] });
  await expect(view).toHaveAttribute('data-range', 'old 23-24');
  await expect(row(22)).toHaveClass(/\bpicked\b/);
  await expect(row(25)).toHaveClass(/\bpicked\b/);
  await expect(row(21)).not.toHaveClass(/\bpicked\b/);
  // The added rows between have no old line: not part of an old range.
  await expect(row(23)).not.toHaveClass(/\bpicked\b/);

  // A plain click starts a new range, on the new side this time.
  await row(23).getByTestId('diff-new').click();
  await expect(view).toHaveAttribute('data-range', 'new 23');
  await expect(row(22)).not.toHaveClass(/\bpicked\b/);
  await expect(row(23)).toHaveClass(/\bpicked\b/);

  // Shift+click upwards extends the other way, across rows of both kinds.
  await row(21).getByTestId('diff-new').click({ modifiers: ['Shift'] });
  await expect(view).toHaveAttribute('data-range', 'new 22-23');
  await expect(row(21)).toHaveClass(/\bpicked\b/);

  // Shift+click on the other side starts over there.
  await row(25).getByTestId('diff-old').click({ modifiers: ['Shift'] });
  await expect(view).toHaveAttribute('data-range', 'old 24');

  // A number cell that is empty (an added row has no old line) does nothing.
  await row(23).getByTestId('diff-old').click({ force: true });
  await expect(view).toHaveAttribute('data-range', 'old 24');

  // Another file clears it.
  await page.getByTestId('file-view-back').click();
  await expect(view).toHaveCount(0);
});
