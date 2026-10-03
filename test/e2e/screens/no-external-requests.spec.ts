// e2e/no-external-requests (SPEC.md section 6, ADR-022): the page talks only
// to 127.0.0.1. The fonts are bundled, so nothing goes to Google Fonts.

import { expect, test, type Request } from '@playwright/test';
import { mockApi } from '../support/mock-api.js';
import { withoutWebgl } from '../support/scene.js';

const SORA_FILE = /\/assets\/sora-[\w-]+\.woff2$/;
const PLEX_FILE = /\/assets\/ibm-plex-mono-[\w-]+\.woff2$/;

test('every request stays on 127.0.0.1, fonts included', async ({ page, context }) => {
  const urls: string[] = [];
  const record = (request: Request): void => {
    urls.push(request.url());
  };
  context.on('request', record);
  // The claim is about requests, not the scene: run the change screen without WebGL.
  await withoutWebgl(page);
  await mockApi(page);

  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await page.goto('/#/repo/1');
  await page.goto('/#/change/11');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('feature/order-discounts');
  await expect(page.getByTestId('no-webgl-note')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox').pressSequentially('order');
  await expect(page.getByRole('option')).toHaveCount(4);
  await page.waitForFunction("document.fonts.status === 'loaded'");

  // Both families are really in use, from local files.
  expect(await page.evaluate("document.fonts.check('600 14px Sora')")).toBe(true);
  expect(await page.evaluate("document.fonts.check('400 12px \"IBM Plex Mono\"')")).toBe(true);
  expect(await page.evaluate('getComputedStyle(document.body).fontFamily')).toMatch(/^"?Sora"?,/);
  expect(urls.some((url) => SORA_FILE.test(url))).toBe(true);
  expect(urls.some((url) => PLEX_FILE.test(url))).toBe(true);

  const external = urls.filter((raw) => {
    const url = new URL(raw);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return false;
    return url.hostname !== '127.0.0.1';
  });
  expect(external).toEqual([]);
  context.off('request', record);
});
