// e2e/standalone/no-network-requests (ADR-002): nothing leaves the page. From
// file:// the only requests are file:// URLs (the page, the script, the
// fonts) and data:/blob: ones; three.js, both font families and the styles are
// bundled, so no CDN, no Google Fonts and no daemon is called.

import { GUARD } from '../../support/hud.js';
import { panelReport } from '../../support/panel.js';
import { project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { recordRequests, test } from '../../support/standalone.js';

test.describe.configure({ timeout: 60_000 });

const SORA = /^file:\/\/.*\/assets\/sora-[\w-]+\.woff2$/;
const PLEX = /^file:\/\/.*\/assets\/ibm-plex-mono-[\w-]+\.woff2$/;
const BUNDLE = /^file:\/\/.*\/assets\/index-[\w-]+\.js$/;
const BUILD_FOLDER = /\/\.tmp\/standalone\//;

test('standalone/no-network-requests', async ({ page, standalone }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const urls = recordRequests(page);
  await standalone.open(panelReport());
  // Use the screen: a click opens the file view, which must not fetch a diff.
  const guard = await project(page, GUARD);
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(page.getByTestId('file-diff')).toBeVisible();
  await page.waitForFunction("document.fonts.status === 'loaded'");

  // The fonts are really loaded, from local files next to the page.
  expect(await page.evaluate("document.fonts.check('600 14px Sora')")).toBe(true);
  expect(await page.evaluate("document.fonts.check('400 12px \"IBM Plex Mono\"')")).toBe(true);
  expect(urls.some((url) => SORA.test(url))).toBe(true);
  expect(urls.some((url) => PLEX.test(url))).toBe(true);
  expect(urls.some((url) => BUNDLE.test(url))).toBe(true);

  const leaving = urls.filter((raw) => {
    const { protocol } = new URL(raw);
    return protocol !== 'file:' && protocol !== 'data:' && protocol !== 'blob:';
  });
  expect(leaving).toEqual([]);
  // No file request goes outside the build folder either.
  expect(urls.filter((raw) => raw.startsWith('file:') && !BUILD_FOLDER.test(raw))).toEqual([]);
});
