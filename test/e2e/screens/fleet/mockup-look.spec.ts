// e2e/fleet/mockup-look (SPEC.md section 6, ADR-022): the Fleet screen is
// drawn with the mockup's tokens and fonts. shell-theme-motion already proves
// that every token has the mockup's value in both schemes; this spec proves
// that the Fleet's own surfaces use those tokens, that its text is set in the
// bundled Sora and IBM Plex Mono, and attaches screenshots of both themes for
// the by-eye comparison with design/mockup.html. Motion follows
// prefers-reduced-motion.

import { expect, test, type Page } from '@playwright/test';
import { computed, resolveColour } from '../../support/css.js';
import { fixtures, mockApi } from '../../support/mock-api.js';

async function openFleet(page: Page): Promise<void> {
  await mockApi(page, { repos: fixtures.fleetIndicators() });
  await page.goto('/#/');
  await expect(page.getByTestId('lot')).toHaveCount(4);
  await page.evaluate('document.fonts.ready.then(() => undefined)');
}

for (const scheme of ['dark', 'light'] as const) {
  test(`the Fleet surfaces use the mockup tokens (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openFleet(page);
    const token = (name: string): Promise<string> => resolveColour(page, `var(${name})`);
    const lot = (id: number, part: string) => page.locator(`[data-testid="lot"][data-repo-id="${String(id)}"] ${part}`);

    expect(await computed(page.locator('.fleet-list'), 'background-color')).toBe(await token('--panel'));
    expect(await computed(page.locator('.fleet-list'), 'border-top-color')).toBe(await token('--line'));
    expect(await computed(page.locator('.fleet-map h1'), 'color')).toBe(await token('--ink'));
    expect(await computed(page.locator('.fleet-map .title p'), 'color')).toBe(await token('--muted'));
    expect(await computed(lot(11, '.name'), 'fill')).toBe(await token('--ink'));
    expect(await computed(lot(12, '.sub'), 'fill')).toBe(await token('--muted'));
    expect(await computed(lot(13, '.sub'), 'fill')).toBe(await token('--del'));
    expect(await computed(lot(13, '.pip-error circle'), 'fill')).toBe(await token('--del'));
    expect(await computed(lot(14, '.pip-collecting circle').last(), 'fill')).toBe(await token('--sig'));
    expect(await computed(page.locator('td[data-col="high"].high'), 'color')).toBe(await token('--sev-high'));
    expect(await computed(page.locator('td[data-col="draft"].zero').first(), 'color')).toBe(await token('--muted'));
    // The error tag's text is the AA text colour of --del (DC-89): the accent itself at night is 4.0:1 on a tinted tag.
    expect(await computed(page.locator('[data-testid="collect-error"]'), 'color')).toBe(await token('--del-text'));
  });
}

test('the text uses the bundled Sora and IBM Plex Mono', async ({ page }) => {
  await openFleet(page);
  expect(await page.evaluate<boolean>(`document.fonts.check('600 20px Sora')`)).toBe(true);
  expect(await page.evaluate<boolean>(`document.fonts.check('500 12.5px "IBM Plex Mono"')`)).toBe(true);
  const loaded = await page.evaluate<string[]>(`[...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', ''))`);
  expect(loaded).toContain('Sora');
  expect(loaded).toContain('IBM Plex Mono');

  for (const selector of ['.fleet-map h1', '.lot .count', '.fleet-list th', '.fleet-map .legend']) {
    expect(await computed(page.locator(selector).first(), 'font-family'), selector).toMatch(/^"?Sora"?,/);
  }
  for (const selector of ['.lot .name', '.fleet-list .name', '.fleet-list .path']) {
    expect(await computed(page.locator(selector).first(), 'font-family'), selector).toMatch(/^"?IBM Plex Mono"?,/);
  }
  // The mockup's title scale.
  expect(await computed(page.locator('.fleet-map h1'), 'font-size')).toBe('20px');
  expect(await computed(page.locator('.fleet-map h1'), 'font-weight')).toBe('600');
});

for (const scheme of ['dark', 'light'] as const) {
  test(`screenshot for the by-eye comparison with the mockup (${scheme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.clock.setFixedTime(new Date('2026-05-04T12:00:00.000Z'));
    await openFleet(page);
    await page.locator('[data-testid="lot"][data-repo-id="11"]').hover();
    await expect(page.locator('.fleet-map .tip')).toHaveClass(/show/);
    const path = testInfo.outputPath(`fleet-${scheme}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`fleet-${scheme}`, { path, contentType: 'image/png' });
  });
}

test('prefers-reduced-motion turns the transitions and the pulse off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFleet(page);
  const durations = async (selector: string): Promise<number[]> =>
    (await computed(page.locator(selector).first(), 'transition-duration')).split(',').map((value) => parseFloat(value));
  for (const selector of ['.lot', '.lot .face', '.lot .shadow', '.fleet-list tbody tr', '.fleet-map .tip']) {
    expect((await durations(selector)).every((value) => value === 0), selector).toBe(true);
  }
  expect(await computed(page.locator('.lot .pulse'), 'animation-name')).toBe('none');
});

test('with motion allowed, a lot lifts smoothly on hover', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openFleet(page);
  const face = page.locator('[data-testid="lot"][data-repo-id="11"] .face');
  expect(parseFloat(await computed(face, 'transition-duration'))).toBeGreaterThan(0);
  await page.locator('[data-testid="lot"][data-repo-id="11"]').hover();
  await expect(face).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -3)');
  expect(await computed(page.locator('.lot .pulse'), 'animation-name')).toBe('fleet-pulse');
});
