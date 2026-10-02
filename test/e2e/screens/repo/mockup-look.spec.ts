// e2e/repo/mockup-look (SPEC.md section 6, ADR-022): the Repo screen is drawn
// with the mockup's tokens: the list on --panel like the reading panel, status
// counters with the status tokens, verdict tags with the verdict tokens, the
// filter chips as the mockup's chips. Screenshots at 700, 1024 and 1440 px in
// both schemes are attached for the by-eye comparison with design/mockup.html
// (DIFFCITY_E2E_SHOTS=<dir> also copies them there).

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { computed, resolveColour } from '../../support/css.js';
import { mockApi } from '../../support/mock-api.js';

const NOW = new Date('2026-05-04T12:00:00.000Z');

async function openRepo(page: Page, hash = '/#/repo/1'): Promise<void> {
  await mockApi(page);
  await page.goto(hash);
  await page.evaluate('document.fonts.ready.then(() => undefined)');
}

for (const scheme of ['dark', 'light'] as const) {
  test(`the Repo surfaces use the mockup tokens (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openRepo(page);
    await expect(page.getByTestId('change-row')).toHaveCount(6);
    const token = (name: string): Promise<string> => resolveColour(page, `var(${name})`);
    const row = (id: number) => page.locator(`[data-testid="change-row"][data-change-id="${String(id)}"]`);

    expect(await computed(page.locator('.repo .changes'), 'background-color')).toBe(await token('--panel'));
    expect(await computed(page.locator('.repo-head h1'), 'color')).toBe(await token('--ink'));
    for (const status of ['add', 'mod', 'sig', 'del']) {
      expect(await computed(row(11).locator(`.stat[data-status="${status}"] .sw`), 'background-color'), status).toBe(await token(`--${status}`));
    }
    expect(await computed(row(11).locator('[data-verdict="eyes"]'), 'color')).toBe(await token('--verdict-eyes'));
    expect(await computed(row(11).locator('[data-verdict="same"]'), 'color')).toBe(await token('--verdict-same'));
    expect(await computed(row(15).locator('[data-verdict="risky"]'), 'color')).toBe(await token('--verdict-risky'));
    expect(await computed(row(11).getByTestId('agent-badge'), 'color')).toBe(await token('--tier'));
    expect(await computed(page.locator('.chip').first(), 'border-top-color')).toBe(await token('--line'));
    expect(await computed(page.getByTestId('show-everything'), 'border-top-style')).toBe('dashed');
  });
}

for (const width of [700, 1024, 1440]) {
  for (const scheme of ['dark', 'light'] as const) {
    test(`screenshot for the by-eye comparison with the mockup (${String(width)} px, ${scheme})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1400 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.clock.setFixedTime(NOW);
      await openRepo(page);
      await expect(page.getByTestId('change-row')).toHaveCount(6);
      // No horizontal scroll at any width.
      expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      const name = `repo-${String(width)}-${scheme}.png`;
      const path = testInfo.outputPath(name);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(name, { path, contentType: 'image/png' });
      const shots = process.env['DIFFCITY_E2E_SHOTS'];
      if (shots) {
        mkdirSync(shots, { recursive: true });
        copyFileSync(path, join(shots, name));
      }
    });
  }
}

test('screenshot of the change placeholder', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.clock.setFixedTime(NOW);
  await openRepo(page, '/#/change/11');
  await expect(page.getByTestId('touched-file')).toHaveCount(6);
  const path = testInfo.outputPath('repo-change-placeholder.png');
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach('repo-change-placeholder', { path, contentType: 'image/png' });
  const shots = process.env['DIFFCITY_E2E_SHOTS'];
  if (shots) copyFileSync(path, join(shots, 'repo-change-placeholder.png'));
});

test('prefers-reduced-motion turns the row transition and the pulses off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openRepo(page);
  await expect(page.getByTestId('computing')).toHaveCount(1);
  expect(parseFloat(await computed(page.getByTestId('change-row').first(), 'transition-duration'))).toBe(0);
  expect(await computed(page.locator('.note.computing i'), 'animation-name')).toBe('none');
});
