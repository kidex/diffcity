// e2e/review/held-key-marks-once (ADR-028): holding C fires keydown repeats;
// only the first one marks, so exactly one PUT goes out.

import { test } from '@playwright/test';
import { GUARD } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { card, openReview, selectFile } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/held-key-marks-once', async ({ page }) => {
  const { api } = await openReview(page);
  const mock = api.review(11);
  await selectFile(page, GUARD, CAN_PLACE);

  // Playwright flags the repeats of a key that is already down as auto-repeat.
  for (let i = 0; i < 8; i += 1) await page.keyboard.down('c');
  await page.keyboard.up('c');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  await page.waitForTimeout(500);
  expect(mock.writes.filter((write) => write.method === 'PUT')).toHaveLength(1);

  // Synthetic repeats too.
  await page.keyboard.press('u');
  await expect.poll(() => mock.writes.filter((write) => write.method === 'DELETE').length).toBe(1);
  const before = mock.writes.length;
  await page.evaluate(`(() => {
    for (let i = 0; i < 5; i += 1) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', repeat: true, bubbles: true }));
  })()`);
  await page.waitForTimeout(500);
  expect(mock.writes).toHaveLength(before);
});
