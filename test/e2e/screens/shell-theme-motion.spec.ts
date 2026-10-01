// e2e/shell-theme-motion (SPEC.md section 6, ADR-022): the shell wears the
// mockup's tokens in both colour schemes, the top bar matches the mockup's
// .top rule, and prefers-reduced-motion stops every animation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../support/mock-api.js';

const mockup = readFileSync(fileURLToPath(new URL('../../../design/mockup.html', import.meta.url)), 'utf8');

/** Custom properties declared in a CSS block body, values normalized. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1] ?? '', normalize(match[2] ?? ''));
  }
  return out;
}

const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

/** The body of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = mockup.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`mockup has no rule for ${selector}`);
  const open = mockup.indexOf('{', start);
  return mockup.slice(open + 1, mockup.indexOf('}', open));
}

const DARK = declarations(ruleBody(':root'));
const LIGHT = new Map([...DARK, ...declarations(ruleBody(':root:not([data-theme="dark"])'))]);

const readTokens = (page: Page, names: string[]): Promise<Record<string, string>> =>
  page.evaluate<Record<string, string>>(
    `Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n)]))`,
  );

/** Resolves a CSS colour expression to the rgb() string the browser computes. */
const resolveColor = (page: Page, value: string): Promise<string> =>
  page.evaluate<string>(
    `(() => { const s = document.createElement('span'); s.style.color = ${JSON.stringify(value)}; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })()`,
  );

async function openHome(page: Page): Promise<void> {
  await mockApi(page);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
}

test('the mockup declares the tokens this spec compares', () => {
  expect(DARK.size).toBeGreaterThanOrEqual(25);
  expect(LIGHT.get('--bg')).not.toBe(DARK.get('--bg'));
});

for (const [scheme, expected] of [
  ['dark', DARK],
  ['light', LIGHT],
] as const) {
  test(`every mockup token has the mockup's value in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openHome(page);
    const actual = await readTokens(page, [...expected.keys()]);
    for (const [name, value] of expected) {
      const got = normalize(actual[name] ?? '');
      if (/^(#|rgb)/.test(value)) {
        // The build may rewrite a colour (rgba(…, .16) → #rrggbb29); compare what it renders as.
        expect.soft(await resolveColor(page, got), name).toBe(await resolveColor(page, value));
      } else {
        expect.soft(got, name).toBe(value);
      }
    }
  });

  test(`body and top bar use the ${scheme} tokens`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openHome(page);
    const [bg, bgDeep, ink, line] = await Promise.all(
      ['--bg', '--bg-deep', '--ink', '--line'].map((name) => resolveColor(page, expected.get(name) ?? '')),
    );
    await expect(page.locator('body')).toHaveCSS('background-color', bg ?? '');
    await expect(page.locator('body')).toHaveCSS('color', ink ?? '');
    const top = page.locator('header.top');
    await expect(top).toHaveCSS('background-color', bgDeep ?? '');
    await expect(top).toHaveCSS('border-bottom', `1px solid ${line ?? ''}`);
  });
}

test('an explicit data-theme wins over the system scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openHome(page);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  expect(normalize((await readTokens(page, ['--bg']))['--bg'] ?? '')).toBe(LIGHT.get('--bg'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  expect(normalize((await readTokens(page, ['--bg']))['--bg'] ?? '')).toBe(DARK.get('--bg'));
});

test('the top bar keeps the mockup layout: brand, breadcrumb, then search and daemon at the right edge', async ({ page }) => {
  await openHome(page);
  const top = page.locator('header.top');
  await expect(top).toHaveCSS('padding', '12px 22px');
  await expect(top).toHaveCSS('display', 'flex');
  await expect(top.locator('.brand')).toHaveCSS('font-weight', '600');
  await expect(top.locator('.search-btn .k')).toHaveCSS('font-family', /^"IBM Plex Mono"/);

  const box = async (selector: string) => {
    const found = await top.locator(selector).boundingBox();
    if (!found) throw new Error(`${selector} is not visible`);
    return found;
  };
  const header = await box(':scope');
  const brand = await box('.brand');
  const crumb = await box('nav[aria-label="Breadcrumb"]');
  const search = await box('.search-btn');
  const daemon = await box('[data-testid="daemon"]');
  expect(brand.x).toBe(22);
  expect(crumb.x).toBeGreaterThan(brand.x + brand.width);
  expect(search.x).toBeGreaterThan(crumb.x + crumb.width);
  expect(daemon.x).toBeGreaterThan(search.x + search.width);
  expect(Math.round(header.width - (daemon.x + daemon.width))).toBe(22);
  // One line: every item is vertically centred in the bar.
  for (const item of [brand, crumb, search, daemon]) {
    expect(Math.abs(item.y + item.height / 2 - (header.y + header.height / 2))).toBeLessThanOrEqual(2);
  }
});

test('the reconnecting dot pulses, and prefers-reduced-motion stops it', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/events', (route) => route.abort('connectionrefused'));
  await page.goto('/#/');
  const dot = page.getByTestId('daemon').locator('i');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'reconnecting');
  await expect(dot).toHaveCSS('animation-name', 'daemon-pulse');
  expect(await page.evaluate<number>('document.getAnimations().length')).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(dot).toHaveCSS('animation-name', 'none');
  expect(await page.evaluate<number>('document.getAnimations().length')).toBe(0);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'reconnecting');
});

test('with reduced motion, opening the palette runs no animation or transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openHome(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Quick search' })).toBeVisible();
  expect(await page.evaluate<number>('document.getAnimations().length')).toBe(0);
});
