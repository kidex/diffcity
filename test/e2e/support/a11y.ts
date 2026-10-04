// Helpers for the accessibility specs (DC-89): the keyboard path through the
// change screen and what the page shows for the element that has focus. The
// test tsconfig has no DOM types, so the page scripts are strings.

import type { Page } from '@playwright/test';

export interface Focus {
  testid: string | null;
  label: string | null;
  text: string;
  tag: string;
  /** The focus ring the browser draws for it: an outline (`--sig` is the token it must be). */
  ring: { style: string; width: number; color: string };
  /** `--sig`, as the browser computes it. */
  sig: string;
  focusVisible: boolean;
}

/** The element that has focus, or null when it is the page itself. */
export const focused = (page: Page): Promise<Focus | null> =>
  page.evaluate<Focus | null>(`(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    const probe = document.createElement('i');
    probe.style.color = 'var(--sig)';
    document.body.append(probe);
    const sig = getComputedStyle(probe).color;
    probe.remove();
    return {
      testid: el.getAttribute('data-testid'),
      label: el.getAttribute('aria-label'),
      text: (el.textContent || '').trim().slice(0, 40),
      tag: el.tagName.toLowerCase(),
      ring: { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor },
      sig,
      focusVisible: el.matches(':focus-visible'),
    };
  })()`);

/**
 * Presses Tab until `done` is satisfied by what has been focused so far (at
 * most `max` presses); returns every stop in order. Each stop is checked for a
 * visible, token-coloured focus ring by the caller.
 */
export async function tabUntil(page: Page, done: (stops: Focus[]) => boolean, max = 160): Promise<Focus[]> {
  const stops: Focus[] = [];
  for (let i = 0; i < max && !done(stops); i += 1) {
    await page.keyboard.press('Tab');
    const now = await focused(page);
    if (now !== null) stops.push(now);
  }
  return stops;
}

/** The ids the page's tab stops had in `stops`: the test id, else the label, else the text. */
export const names = (stops: readonly Focus[]): string[] => stops.map((stop) => stop.testid ?? stop.label ?? stop.text);
