// e2e/panel/steps-sections (DC-105): the Execution order tab lists the real
// steps of the golden order-discounts change under three headings, in reading
// order: Execution path, then Migrations, then Unconnected. Each heading
// counts its stops and says what it holds; the cards under it are its steps,
// by order. One page load for the file: the cases only read the panel.

import type { Page } from '@playwright/test';
import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { fixtures } from '../../support/mock-api.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { attributesOf, openPanel, stepName, stepsOf, stopCards, stopSection, stopSections } from '../../support/panel.js';

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let page: Page;
const report: Report = fixtures.reportWithSteps();

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openPanel(page, report);
});
test.afterAll(async () => {
  await page.close();
});

test('panel/steps-sections/sections-render-with-headings', async () => {
  const sections = stopSections(page);
  await expect(sections).toHaveCount(3);
  await expect(sections.getByTestId('section-label')).toHaveText(['Execution path', 'Migrations', 'Unconnected']);
  await expect(page.getByTestId('section-heading')).toHaveText(['Execution path15', 'Migrations2', 'Unconnected7']);
  for (const name of ['Execution path, 15 stops', 'Migrations, 2 stops', 'Unconnected, 7 stops']) {
    await expect(page.getByRole('heading', { level: 3, name, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('section-note')).toHaveText([
    'From each entry point, in the order the code runs',
    'Touched SQL migrations, read after the execution path',
    'Touched symbols no entry point reaches',
  ]);
  // Every step has its card, once, in the order of the steps; the empty text is gone.
  await expect(stopCards(page)).toHaveCount(report.steps.length);
  expect(await attributesOf(page, 'stop-card', 'data-order')).toEqual(report.steps.map((one) => String(one.order)));
  await expect(page.getByTestId('empty-steps')).toHaveCount(0);
  const path = stepsOf(report, 'path');
  await expect(stopSection(page, 'path').getByTestId('stop-symbol')).toHaveText(path.map(stepName));
  // The rail runs within a section: its first card's rail starts at the node.
  const top = await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-section="migration"] .step .rail')).top`);
  expect(top).toBe('22px');
});

test('panel/steps-sections/unconnected-section-last', async () => {
  const unconnected = stepsOf(report, 'unconnected');
  await expect(stopSections(page).last()).toHaveAttribute('data-section', 'unconnected');
  const cards = stopSection(page, 'unconnected').getByTestId('stop-card');
  await expect(cards.getByTestId('stop-symbol')).toHaveText(unconnected.map(stepName));
  await expect(cards.getByTestId('stop-why')).toHaveText(unconnected.map((one) => one.why));
  // The last card of the tab is the last step.
  await expect(stopCards(page).last()).toHaveAttribute('data-order', String(Math.max(...report.steps.map((one) => one.order))));
});

test('panel/steps-sections/migration-section-before-unconnected', async () => {
  const migrations = stepsOf(report, 'migration');
  await expect(stopSections(page).nth(1)).toHaveAttribute('data-section', 'migration');
  const cards = stopSection(page, 'migration').getByTestId('stop-card');
  await expect(cards.getByTestId('stop-symbol')).toHaveText(['ALTER TABLE orders', 'CREATE INDEX orders_discount_idx']);
  await expect(cards.getByTestId('stop-why')).toHaveText(migrations.map((one) => one.why));
  // After the path's last step, before the first unconnected one.
  const orders = await Promise.all((await cards.all()).map(async (card) => Number(await card.getAttribute('data-order'))));
  const lastPath = Math.max(...stepsOf(report, 'path').map((one) => one.order));
  const firstUnconnected = Math.min(...stepsOf(report, 'unconnected').map((one) => one.order));
  for (const order of orders) {
    expect(order).toBeGreaterThan(lastPath);
    expect(order).toBeLessThan(firstUnconnected);
  }
  const next = await page.evaluate<string | null>(`document.querySelector('[data-section="migration"]').nextElementSibling?.getAttribute('data-section') ?? null`);
  expect(next).toBe('unconnected');
});
