// e2e/repo/notes (DC-61): the daemon's repo notes show as calm info banners
// under the repo header, one per note; the untrusted-config note is explained
// and comes with the trust command to copy. A note the UI does not know shows
// its text as is. Without notes nothing is drawn, and a live update that drops
// the note takes the banner away with no reload.

import { expect, test, type Page } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { emitSse, tagClient } from '../../support/sse.js';

const UNTRUSTED = 'config not loaded: repo not trusted (run diffcity trust)';
const AA = 4.5;

test('an untrusted-config note is explained, with the trust command to copy', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const detail = fixtures.repoMixedChanges();
  detail.repo.notes = [UNTRUSTED];
  await mockApi(page, { details: [detail] });
  await page.goto('/#/repo/1');
  const banner = page.getByTestId('repo-note');
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText('This repo has a diffcity.config.js that isn’t loaded because the repo isn’t trusted. Defaults are used for the base and tier 1.');
  await expect(banner.getByTestId('note-command')).toHaveText(`diffcity trust ${detail.repo.path}`);
  // Under the header, above the filters.
  const [head, note, filters] = await Promise.all(
    ['.repo-head', '[data-testid="repo-note"]', '.repo .filters'].map((selector) => page.locator(selector).first().boundingBox()),
  );
  expect(note && head && filters && head.y + head.height <= note.y && note.y + note.height <= filters.y).toBe(true);

  await banner.getByRole('button', { name: 'Copy the command' }).click();
  await expect(banner.getByRole('button')).toHaveText('Copied');
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe(`diffcity trust ${detail.repo.path}`);
});

test('an unknown note shows its text as is, as text and not as markup', async ({ page }) => {
  const detail = fixtures.repoMixedChanges();
  detail.repo.notes = ['something the daemon says <b>now</b>'];
  await mockApi(page, { details: [detail] });
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('repo-note')).toHaveText(/something the daemon says <b>now<\/b>/);
  await expect(page.getByTestId('note-command')).toHaveCount(0);
  await expect(page.locator('[data-testid="repo-note"] b')).toHaveCount(0);
});

test('without notes nothing is drawn', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.getByTestId('repo-note')).toHaveCount(0);
  await expect(page.getByTestId('repo-notes')).toBeHidden();
});

test('SSE repo without the note → the banner goes, no reload', async ({ page }, testInfo) => {
  const detail = fixtures.repoMixedChanges();
  detail.repo.notes = [UNTRUSTED];
  await mockApi(page, { details: [detail] });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('repo-note')).toHaveCount(1);
  await page.evaluate('window.noReload = true');

  detail.repo.notes = [];
  await emitSse(page, testInfo.testId, 'repo', { repoId: 1 });
  await expect(page.getByTestId('repo-note')).toHaveCount(0);
  expect(await page.evaluate<boolean>('window.noReload === true')).toBe(true);
});

test('the Fleet marks a repo with a note, names it, and drops it on an SSE update', async ({ page }, testInfo) => {
  const repos = fixtures.fleetThreeRepos();
  const [shop] = repos;
  if (!shop) throw new Error('fleet-three-repos.json is empty');
  repos[0] = { ...shop, notes: [UNTRUSTED] };
  await mockApi(page, { repos });
  await tagClient(page, testInfo.testId);
  await page.goto('/#/');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  const row = page.getByTestId('repo-row').filter({ hasText: shop.name });
  const tag = row.getByTestId('repo-note-indicator');
  await expect(tag).toHaveCount(1);
  await expect(tag).toHaveAttribute('aria-label', /^Note: This repo has a diffcity\.config\.js that isn’t loaded.* Run: diffcity trust /);
  await expect(tag).toHaveAttribute('title', /Defaults are used for the base and tier 1/);
  await expect(page.getByTestId('lot-note')).toHaveCount(1);
  await expect(page.locator(`[data-testid="lot"][data-repo-id="${String(shop.id)}"]`)).toHaveAttribute('aria-label', /note: This repo has a diffcity\.config\.js/);
  // No other repo gets one.
  await expect(page.getByTestId('repo-note-indicator')).toHaveCount(1);

  repos[0] = { ...shop, notes: [] };
  await emitSse(page, testInfo.testId, 'repo', { repoId: shop.id });
  await expect(page.getByTestId('repo-note-indicator')).toHaveCount(0);
  await expect(page.getByTestId('lot-note')).toHaveCount(0);
});

test('a repo without notes keeps its row height with a note elsewhere', async ({ page }) => {
  const repos = fixtures.fleetThreeRepos();
  const heights = async (): Promise<number[]> => {
    const rows = await page.getByTestId('repo-row').all();
    return Promise.all(rows.map(async (row) => (await row.boundingBox())?.height ?? 0));
  };
  await mockApi(page, { repos });
  await page.goto('/#/');
  await expect(page.getByTestId('repo-row')).toHaveCount(3);
  const before = await heights();

  const second = repos[1];
  if (!second) throw new Error('fleet-three-repos.json has fewer than two repos');
  repos[1] = { ...second, notes: [UNTRUSTED] };
  await page.reload();
  await expect(page.getByTestId('repo-note-indicator')).toHaveCount(1);
  const after = await heights();
  expect(after[0]).toBe(before[0]);
  expect(after[2]).toBe(before[2]);
});

// In-page: the colour of each text of the scope over what is painted under it.
const READ_CONTRASTS = `((selector) => {
  const parse = (value) => {
    let m = /^rgba?\\(([^)]+)\\)$/.exec(value);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = /^color\\(srgb ([^)]+)\\)$/.exec(value);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
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
  const readings = [];
  for (const root of document.querySelectorAll(selector)) {
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const own = [...element.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
      if (!own || element.getClientRects().length === 0) continue;
      const bg = background(element);
      const fg = over(parse(getComputedStyle(element).color), bg);
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      readings.push({ text: own, ratio: (hi + 0.05) / (lo + 0.05) });
    }
  }
  return readings;
})`;

async function lowContrast(page: Page, selector: string): Promise<{ text: string; ratio: number }[]> {
  const readings = await page.evaluate<{ text: string; ratio: number }[]>(`${READ_CONTRASTS}(${JSON.stringify(selector)})`);
  expect(readings.length).toBeGreaterThan(1);
  return readings.filter((reading) => reading.ratio < AA);
}

for (const scheme of ['dark', 'light'] as const) {
  test(`the banner and the Fleet tag reach 4.5:1 (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const detail = fixtures.repoMixedChanges();
    detail.repo.notes = [UNTRUSTED];
    const repos = fixtures.fleetThreeRepos();
    const [shop] = repos;
    if (!shop) throw new Error('fleet-three-repos.json is empty');
    repos[0] = { ...shop, notes: [UNTRUSTED] };
    await mockApi(page, { details: [detail], repos });

    await page.goto('/#/repo/1');
    await expect(page.getByTestId('repo-note')).toHaveCount(1);
    expect(await lowContrast(page, '[data-testid="repo-note"]')).toEqual([]);

    await page.goto('/#/');
    await expect(page.getByTestId('repo-note-indicator')).toHaveCount(1);
    expect(await lowContrast(page, '[data-testid="repo-note-indicator"]')).toEqual([]);
  });
}

for (const width of [700, 1024, 1440]) {
  test(`the banner keeps the 22 px gutter and does not overflow at ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const detail = fixtures.repoMixedChanges();
    detail.repo.notes = [UNTRUSTED];
    await mockApi(page, { details: [detail] });
    await page.goto('/#/repo/1');
    const box = await page.getByTestId('repo-note').boundingBox();
    const head = await page.locator('.repo-head').first().boundingBox();
    if (!box || !head) throw new Error('banner or header not laid out');
    expect(Math.round(box.x)).toBe(22);
    expect(Math.round(box.x + box.width)).toBe(width - 22);
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  });
}
