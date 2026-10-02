// e2e/repo/header-gutter (DC-54): the gutter moved from the title to the
// Repo header; the title, the path and the actions still start and end at
// 22 px at every width, wrapped or not.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

for (const width of [700, 1024, 1440]) {
  test(`the header keeps the 22 px gutter at ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    await page.goto('/#/repo/1');
    await expect(page.getByTestId('change-row')).toHaveCount(6);
    const h1 = await page.locator('.repo-head h1').boundingBox();
    expect(h1?.x).toBe(22);
    const audit = await page.getByTestId('audit-now').boundingBox();
    if (!audit) throw new Error('Audit now not rendered');
    expect(Math.round(audit.x + audit.width)).toBe(width - 22);
  });
}
