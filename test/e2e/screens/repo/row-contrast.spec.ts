// e2e/repo/row-contrast (DC-57): every piece of text on a change row, its
// badges and verdict tiles included, and the list header, reaches the WCAG AA
// contrast of 4.5:1 against what is painted under it, in both schemes, on the
// open and on the closed list.

import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';

const AA = 4.5;

interface Reading {
  text: string;
  ratio: number;
}

// In-page: each element with its own text, its colour composited over the
// backgrounds of its ancestors, and the contrast ratio of the two.
const READ_CONTRASTS = `(() => {
  const parse = (value) => {
    let m = /^rgba?\\(([^)]+)\\)$/.exec(value);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = /^color\\(srgb ([^)]+)\\)$/.exec(value);
    if (m) {
      const p = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    throw new Error('unparsed colour ' + value);
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const luminance = (c) => {
    const [r, g, b] = c.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const background = (element) => {
    const chain = [];
    for (let e = element; e; e = e.parentElement) chain.unshift(e);
    let colour = [255, 255, 255, 1];
    for (const e of chain) colour = over(parse(getComputedStyle(e).backgroundColor), colour);
    return colour;
  };
  const scope = [...document.querySelectorAll('[data-testid="change-row"], .repo .changes header, .repo .filters.closed')];
  const readings = [];
  for (const root of scope) {
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const own = [...element.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
      if (!own || element.getClientRects().length === 0 || getComputedStyle(element).visibility === 'hidden') continue;
      const bg = background(element);
      const fg = over(parse(getComputedStyle(element).color), bg);
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      readings.push({ text: own, ratio: (hi + 0.05) / (lo + 0.05) });
    }
  }
  return readings;
})()`;

async function lowContrast(page: Page): Promise<Reading[]> {
  const readings = await page.evaluate<Reading[]>(READ_CONTRASTS);
  expect(readings.length).toBeGreaterThan(20);
  return readings.filter((reading) => reading.ratio < AA);
}

for (const scheme of ['dark', 'light'] as const) {
  test(`row text and badges reach 4.5:1 (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await mockApi(page);
    await page.goto('/#/repo/1');
    await expect(page.getByTestId('change-row')).toHaveCount(6);
    expect(await lowContrast(page)).toEqual([]);

    await page.getByTestId('archive-toggle').click();
    await expect(page.getByTestId('change-row')).toHaveCount(4);
    expect(await lowContrast(page)).toEqual([]);
  });
}
