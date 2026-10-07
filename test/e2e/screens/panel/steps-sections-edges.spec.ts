// e2e/panel/steps-sections-edges (DC-105): the reading panel's sections on
// Reports the golden change does not produce. Only unconnected steps, only
// migrations, steps without a section (Reports stored before phase 4) or with
// one this UI does not know, a step on a file the Report does not have, 300+
// steps walked with J and K, a long `why` with a 120-line diff, the keyboard
// alone (Tab to a card, Enter, Esc), and the list without WebGL.

import type { Page } from '@playwright/test';
import { test } from '@playwright/test';
import type { DiffLine, Report, Step } from '../../../../src/core/report/types.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { sceneExpect as expect, selectedFloor, withoutWebgl } from '../../support/scene.js';
import { openPanel, stepsOf, stopCards, stopSection, stopSections } from '../../support/panel.js';

test.describe.configure({ timeout: 120_000 });

/** The golden Report with its steps rewritten by `edit`. */
function withSteps(edit: (steps: Step[]) => Step[]): Report {
  const report = fixtures.reportWithSteps();
  report.steps = edit(report.steps);
  return report;
}

const labels = (page: Page) => stopSections(page).getByTestId('section-label');
const summary = (page: Page) => page.getByTestId('panel-summary');

test('panel/steps-sections-edges/only-unconnected', async ({ page }) => {
  const report = withSteps((steps) => steps.filter((one) => one.section === 'unconnected'));
  await openPanel(page, report);
  await expect(labels(page)).toHaveText(['Unconnected']);
  await expect(page.getByRole('heading', { level: 3, name: 'Unconnected, 7 stops', exact: true })).toBeVisible();
  await expect(stopCards(page)).toHaveCount(7);
  await expect(page.getByTestId('empty-steps')).toHaveCount(0);
  await expect(summary(page)).toHaveText('7 stops, in reading order');
  await page.keyboard.press('j');
  await expect.poll(() => selectedFloor(page)).toBe(report.steps[0]?.symbolId);
});

test('panel/steps-sections-edges/only-migrations', async ({ page }) => {
  await openPanel(page, withSteps((steps) => steps.filter((one) => one.section === 'migration')));
  await expect(labels(page)).toHaveText(['Migrations']);
  await expect(page.getByRole('heading', { level: 3, name: 'Migrations, 2 stops', exact: true })).toBeVisible();
  await expect(stopCards(page)).toHaveCount(2);
  await expect(summary(page)).toHaveText('2 stops, in reading order');
});

test('panel/steps-sections-edges/old-report-unknown-section-missing-file', async ({ page }) => {
  // No section anywhere (a Report stored before phase 4), one unknown section,
  // and one step on a file the Report does not have.
  const report = withSteps((steps) => {
    const plain = steps.slice(0, 5).map((one) => {
      const copy = { ...one };
      delete copy.section;
      return copy;
    });
    const unknown = { ...steps[5], section: 'sideways' } as unknown as Step;
    const gone: Step = { order: 99, fileId: 'src/gone/missing.ts', symbolId: 'src/gone/missing.ts#lost', why: 'gone', diff: [] };
    return [...plain, unknown, gone];
  });
  await openPanel(page, report);
  await expect(labels(page)).toHaveText(['Execution path']);
  await expect(page.getByRole('heading', { level: 3, name: 'Execution path, 6 stops', exact: true })).toBeVisible();
  await expect(stopCards(page)).toHaveCount(6);
  await expect(summary(page)).toHaveText('6 stops, in the order the code runs');
  await expect(page.locator('[data-testid="stop-card"][data-symbol="src/gone/missing.ts#lost"]')).toHaveCount(0);
});

test('panel/steps-sections-edges/three-hundred-steps-walk', async ({ page }) => {
  // 320 steps over the golden's files: path, migration and unconnected in thirds.
  const base = fixtures.reportWithSteps();
  // Each step its own symbol (a symbol is one stop), added to the golden's files as touched functions.
  const files = base.packages.flatMap((pkg) => pkg.files);
  const sections: NonNullable<Step['section']>[] = ['path', 'migration', 'unconnected'];
  const COUNT = 320;
  base.steps = Array.from({ length: COUNT }, (_, i) => {
    const file = files[i % files.length];
    if (file === undefined) throw new Error('no files');
    const symbolId = `${file.id}#step${String(i + 1)}`;
    file.symbols.push({ id: symbolId, name: `step${String(i + 1)}`, kind: 'function', status: 'mod', range: { start: 1000 + i * 3, end: 1002 + i * 3 } });
    return { order: i + 1, fileId: file.id, symbolId, section: sections[Math.floor((i * 3) / COUNT)] ?? 'path', why: `Step ${String(i + 1)}`, diff: [{ kind: 'add', text: `line ${String(i)}` }] };
  });
  const opened = Date.now();
  await openPanel(page, base);
  await expect(stopCards(page)).toHaveCount(COUNT);
  test.info().annotations.push({ type: 'ms to open', description: String(Date.now() - opened) });
  await expect(labels(page)).toHaveText(['Execution path', 'Migrations', 'Unconnected']);

  const started = Date.now();
  for (let i = 0; i < COUNT + 5; i += 1) await page.keyboard.press('j');
  await expect(stopCards(page).nth(COUNT - 1)).toHaveClass(/\bon\b/);
  const perKey = (Date.now() - started) / (COUNT + 5);
  // A key must stay well under a frame budget's tens of milliseconds even with the city drawn.
  test.info().annotations.push({ type: 'ms per J', description: perKey.toFixed(1) });
  expect(perKey).toBeLessThan(150);
  await expect(page.locator('[data-testid="stop-card"].on')).toHaveCount(1);
  await page.keyboard.press('k');
  await expect(stopCards(page).nth(COUNT - 2)).toHaveClass(/\bon\b/);
  // The current card is scrolled into the list.
  await expect(stopCards(page).nth(COUNT - 2)).toBeInViewport();
});

test('panel/steps-sections-edges/long-why-and-120-line-diff', async ({ page }) => {
  const why = `${'The discount is applied before the total is rounded and stored. '.repeat(40)}end`;
  const diff: DiffLine[] = Array.from({ length: 119 }, (_, i) => ({ kind: (['ctx', 'add', 'del'] as const)[i % 3] ?? 'ctx', text: `const value${String(i)} = ${'x'.repeat(i === 7 ? 4000 : 60)};` }));
  diff.push({ kind: 'ctx', text: '... 37 more lines' });
  const report = withSteps((steps) => steps.map((one, i) => (i === 0 ? { ...one, why, diff } : one)));
  await openPanel(page, report);
  const card = stopCards(page).first();
  await expect(card.getByTestId('stop-why')).toHaveText(why);
  await expect(card.getByTestId('step-diff').locator('.l')).toHaveCount(120);
  await expect(card.getByTestId('step-diff').locator('.l').last()).toContainText('... 37 more lines');
  // The 4000-character line does not widen the panel: the list never scrolls sideways.
  const overflow = await page.evaluate<number>(`(() => { const n = document.querySelector('[data-testid="panel-scroll"]'); return n.scrollWidth - n.clientWidth; })()`);
  expect(overflow).toBeLessThanOrEqual(1);
  const [panelBox, cardBox] = await Promise.all([page.getByTestId('reading-panel').boundingBox(), card.boundingBox()]);
  if (panelBox === null || cardBox === null) throw new Error('no box');
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
  // The sections that follow are still there.
  await expect(labels(page)).toHaveText(['Execution path', 'Migrations', 'Unconnected']);
});

test('panel/steps-sections-edges/keyboard-only-tab-enter-esc', async ({ page }) => {
  const report = fixtures.reportWithSteps();
  await openPanel(page, report);
  // Tab from the top of the page until a stop card has the focus.
  let found = false;
  for (let i = 0; i < 80 && !found; i += 1) {
    await page.keyboard.press('Tab');
    found = await page.evaluate<boolean>(`document.activeElement?.getAttribute('data-testid') === 'stop-card'`);
  }
  expect(found).toBe(true);
  const symbolId = await page.evaluate<string | null>(`document.activeElement.getAttribute('data-symbol')`);
  expect(symbolId).toBe(stepsOf(report, 'path')[0]?.symbolId);
  // Tab goes on through the card's own controls, then to the next card.
  const visited: string[] = [];
  let next: string | null = null;
  for (let i = 0; i < 10 && next === null; i += 1) {
    await page.keyboard.press('Tab');
    const [testId, symbol, text] = await page.evaluate<[string | null, string | null, string]>(
      `[document.activeElement.getAttribute('data-testid'), document.activeElement.getAttribute('data-symbol'), document.activeElement.tagName + ':' + (document.activeElement.textContent ?? '').slice(0, 30)]`,
    );
    visited.push(text);
    if (testId === 'stop-card') next = symbol;
  }
  expect(next, visited.join(' | ')).toBe(stepsOf(report, 'path')[1]?.symbolId);

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('file-view')).toBeVisible();
  await expect(page.getByTestId('file-view-back')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('file-view')).toBeHidden();
  await expect(page.locator(`[data-testid="stop-card"][data-symbol="${String(next)}"]`)).toBeFocused();

  // The Back button gives the focus back the same way as Esc.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('file-view-back')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('file-view')).toBeHidden();
  await expect(page.locator(`[data-testid="stop-card"][data-symbol="${String(next)}"]`)).toBeFocused();
});

test('panel/steps-sections-edges/no-webgl-list-shows-sections', async ({ page }) => {
  const report = fixtures.reportWithSteps();
  await withoutWebgl(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: report }, review: {} });
  await page.goto('/#/change/11');
  await expect(page.getByTestId('no-webgl-note')).toBeVisible();
  await expect(labels(page)).toHaveText(['Execution path', 'Migrations', 'Unconnected']);
  await expect(stopCards(page)).toHaveCount(24);
  // J walks past the path into the migrations without the city.
  for (let i = 0; i < 16; i += 1) await page.keyboard.press('j');
  await expect(stopSection(page, 'migration').locator('.step.on')).toHaveCount(1);
  await expect(page.locator('[data-testid="touched-file"].on')).toHaveAttribute('data-path', stepsOf(report, 'migration')[0]?.fileId ?? '');
});
