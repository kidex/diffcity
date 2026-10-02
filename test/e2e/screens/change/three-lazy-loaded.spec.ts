// e2e/change/three-lazy-loaded: Fleet and Repo never download three.js; the
// change screen's chunk brings it the first time a change opens.

import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

/** Collects the JavaScript the page downloads, with its source. */
function scripts(page: Page): { url: string; body: Promise<string> }[] {
  const seen: { url: string; body: Promise<string> }[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script') return;
    seen.push({ url: response.url(), body: response.text().catch(() => '') });
  });
  return seen;
}

// three.js minified keeps this literal in its WebGL renderer.
const THREE_MARK = 'WebGLRenderer';

test('change/three-lazy-loaded', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page);
  const seen = scripts(page);

  await page.goto('/#/');
  await expect(page.locator('[data-testid="lot"]').first()).toBeVisible();
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row').first()).toBeVisible();
  const before = seen.length;
  for (const script of seen) expect(await script.body, script.url).not.toContain(THREE_MARK);

  await page.getByRole('link', { name: 'Add percentage discounts to orders' }).click();
  await expect(page.getByTestId('city')).toHaveAttribute('data-ready', 'true');
  const loaded = seen.slice(before);
  expect(loaded.length).toBeGreaterThan(0);
  const bodies = await Promise.all(loaded.map((script) => script.body));
  expect(bodies.some((body) => body.includes(THREE_MARK))).toBe(true);
});
