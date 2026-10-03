// e2e/shell-keyboard (SPEC.md section 6, ADR-022): the top bar works from the
// keyboard alone. Tab walks brand → breadcrumb links → search in reading
// order with a visible focus ring, Cmd+K / Ctrl+K opens the palette from any
// focused control, and Esc gives focus back to that control.

import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../support/mock-api.js';
import { withoutWebgl } from '../support/scene.js';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Quick search' });
const input = (page: Page) => page.getByRole('combobox', { name: 'Search repos, branches and files' });

/** A short description of the focused element, for comparing focus order. */
const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  const name = el.getAttribute('aria-label') ?? el.textContent ?? '';
  return el.tagName.toLowerCase() + ':' + name.trim().replace(/\\s+/g, ' ');
})()`;
const focused = (page: Page): Promise<string> => page.evaluate<string>(FOCUSED);

async function openChange(page: Page): Promise<void> {
  await mockApi(page);
  await withoutWebgl(page);
  await page.goto('/#/change/11');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'sample-shop' })).toBeVisible();
  // The top bar is what these specs walk: no city, no WebGL context to compile.
  await expect(page.getByTestId('no-webgl-note')).toBeVisible();
}

test('Tab walks the top bar in reading order, Shift+Tab walks back', async ({ page }) => {
  await openChange(page);

  const forward: string[] = [];
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press('Tab');
    forward.push(await focused(page));
  }
  expect(forward[0]).toBe('a:diffcity, all repos');
  expect(forward[1]).toBe('a:Fleet');
  expect(forward[2]).toBe('a:sample-shop');
  expect(forward[3]).toMatch(/^button:Search/);

  // The current page crumb is text, not a stop.
  await page.keyboard.press('Shift+Tab');
  expect(await focused(page)).toBe('a:sample-shop');
  await page.keyboard.press('Shift+Tab');
  expect(await focused(page)).toBe('a:Fleet');
});

test('a focused top bar control shows the focus ring from the mockup', async ({ page }) => {
  await openChange(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const fleet = page.getByRole('link', { name: 'Fleet', exact: true });
  await expect(fleet).toBeFocused();
  const ring = await page.evaluate<{ style: string; width: string; color: string; sigRgb: string }>(`(() => {
    const style = getComputedStyle(document.activeElement);
    const probe = document.createElement('span');
    probe.style.color = 'var(--sig)';
    document.body.append(probe);
    const sigRgb = getComputedStyle(probe).color;
    probe.remove();
    return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, sigRgb };
  })()`);
  expect(ring.style).toBe('solid');
  expect(ring.width).toBe('2px');
  expect(ring.color).toBe(ring.sigRgb);
});

test('Enter on a focused crumb follows it', async ({ page }) => {
  await openChange(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('a:sample-shop');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/repo\/1$/);
});

test('Cmd+K from a focused crumb opens the palette, and Esc gives focus back to that crumb', async ({ page }) => {
  await openChange(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('a:sample-shop');

  await page.keyboard.press('ControlOrMeta+k');
  await expect(dialog(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await input(page).pressSequentially('order');
  await expect(page.getByRole('option')).toHaveCount(4);

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  expect(await focused(page)).toBe('a:sample-shop');
  await expect(page).toHaveURL(/#\/change\/11$/);
});

test('Ctrl+K from nothing focused opens the palette, and Esc leaves focus on the page', async ({ page }) => {
  await openChange(page);
  expect(await focused(page)).toBe('body');
  await page.keyboard.press('Control+k');
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  // Wait on focus itself, not on the dialog: being hidden and losing focus
  // are separate steps in the browser.
  await expect.poll(() => focused(page)).toBe('body');
  // Tab still starts from the top bar.
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('a:diffcity, all repos');
});

test('Enter on the focused search button opens the palette', async ({ page }) => {
  await openChange(page);
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Tab');
  expect(await focused(page)).toMatch(/^button:Search/);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await focused(page)).toMatch(/^button:Search/);
});
