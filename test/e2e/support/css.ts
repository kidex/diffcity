// Computed-style reads for the screen specs. The e2e code is type-checked
// with the Node libs (no DOM), so the in-page code either is a string, as in
// the other specs, or types the little of the DOM it touches by hand.

import type { Locator, Page } from '@playwright/test';

/** The slice of the browser's window that `computed` uses, typed without the DOM lib. */
interface StyleWindow {
  getComputedStyle(element: unknown): { getPropertyValue(property: string): string };
}

/** The computed value of a CSS property on the element `locator` points at. */
export function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate((element: unknown, name: string) => (globalThis as unknown as StyleWindow).getComputedStyle(element).getPropertyValue(name), property);
}

/** The rgb() string the browser computes for a colour expression, e.g. `var(--panel)`. */
export function resolveColour(page: Page, value: string): Promise<string> {
  return page.evaluate<string>(
    `(() => { const s = document.createElement('span'); s.style.color = ${JSON.stringify(value)}; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })()`,
  );
}
