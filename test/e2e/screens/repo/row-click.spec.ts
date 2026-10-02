// e2e/repo/row-click: a click anywhere on a row opens its change, but a
// ctrl/meta or middle click opens a new tab, and the end of a text-selection
// drag does not navigate.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
});

for (const how of ['ControlOrMeta', 'middle'] as const) {
  test(`a ${how} click on a row opens the change in a new tab`, async ({ page, context }) => {
    const where = page.locator('[data-testid="change-row"][data-change-id="13"] .where');
    const opened = context.waitForEvent('page');
    if (how === 'middle') await where.click({ button: 'middle' });
    else await where.click({ modifiers: ['ControlOrMeta'] });
    const tab = await opened;
    await expect(tab).toHaveURL(/#\/change\/13$/);
    await expect(page).toHaveURL(/#\/repo\/1$/);
  });
}

test('selecting text on a row does not open it', async ({ page }) => {
  const ref = page.locator('[data-testid="change-row"][data-change-id="11"] [data-testid="ref"]');
  const box = await ref.boundingBox();
  if (!box) throw new Error('the ref is not rendered');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate<string>('String(getSelection())')).not.toBe('');
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/#\/repo\/1$/);
});

test('a plain click on a row still opens it', async ({ page }) => {
  await page.locator('[data-testid="change-row"][data-change-id="13"] .where').click();
  await expect(page).toHaveURL(/#\/change\/13$/);
});
