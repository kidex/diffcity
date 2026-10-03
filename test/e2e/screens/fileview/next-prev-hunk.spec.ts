// e2e/fileview/next-prev-hunk (SPEC.md section 6): N goes to the next hunk,
// Shift+N to the previous one, with a counter "2 / 3"; the keys stop at the
// ends, are ignored in editable fields and stop with the file view.

import { test, type Page } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { openDiff, scrollHeightOf, serveGuard, setScroll } from '../../support/fileview.js';

test.describe.configure({ timeout: 90_000 });

/** Whether a row is inside the viewport's visible box. */
const inView = (page: Page, row: number): Promise<boolean> =>
  page.evaluate<boolean>(`(() => {
    const box = document.querySelector('[data-testid="diff-viewport"]').getBoundingClientRect();
    const node = document.querySelector('[data-row="${String(row)}"]');
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  })()`);

test('fileview/next-prev-hunk', async ({ page }) => {
  await openDiff(page, serveGuard());
  const counter = page.getByTestId('hunk-counter');
  await expect(counter).toHaveText('1 / 3');
  expect(await inView(page, 22)).toBe(true);

  await page.keyboard.press('n');
  await expect(counter).toHaveText('2 / 3');
  await expect.poll(() => inView(page, 47)).toBe(true);

  await page.keyboard.press('n');
  await expect(counter).toHaveText('3 / 3');
  await expect.poll(() => inView(page, 57)).toBe(true);

  // At the last hunk N stays.
  await page.keyboard.press('n');
  await expect(counter).toHaveText('3 / 3');

  await page.keyboard.press('Shift+N');
  await expect(counter).toHaveText('2 / 3');
  await expect.poll(() => inView(page, 47)).toBe(true);
  await page.keyboard.press('Shift+N');
  await expect(counter).toHaveText('1 / 3');
  await expect.poll(() => inView(page, 22)).toBe(true);
  await page.keyboard.press('Shift+N');
  await expect(counter).toHaveText('1 / 3');

  // The buttons do the same.
  await page.getByTestId('hunk-next').click();
  await expect(counter).toHaveText('2 / 3');
  await page.getByTestId('hunk-prev').click();
  await expect(counter).toHaveText('1 / 3');

  // Keys typed in an editable field are not ours.
  await page.evaluate(`(() => { const input = document.createElement('input'); input.id = 'probe'; document.body.append(input); input.focus(); })()`);
  await page.keyboard.press('n');
  await expect(counter).toHaveText('1 / 3');
  await page.evaluate(`document.getElementById('probe').remove()`);

  // A key with a modifier is not ours either.
  await page.keyboard.press('Control+n');
  await expect(counter).toHaveText('1 / 3');

  // The reader scrolls on their own: N and Shift+N go on from the hunk at the top of the viewport.
  await setScroll(page, await scrollHeightOf(page));
  await page.keyboard.press('Shift+N');
  await expect(counter).toHaveText('1 / 3');
  await expect.poll(() => inView(page, 22)).toBe(true);
  await setScroll(page, await scrollHeightOf(page));
  await page.keyboard.press('n');
  await expect(counter).toHaveText('2 / 3');
  await expect.poll(() => inView(page, 47)).toBe(true);

  // Esc closes the file view and the keys go with it.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('diff-view')).toHaveCount(0);
  await page.keyboard.press('n');
  await expect(page.getByTestId('diff-view')).toHaveCount(0);
});
