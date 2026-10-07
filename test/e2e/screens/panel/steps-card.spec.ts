// e2e/panel/steps-card (DC-105): a step card of the golden change shows its
// `why` and its inline diff line by line, in every section; the findings the
// Report anchored to the step's symbol sit under it, and only there; a click
// on a card selects its building and floor and opens the file view, while
// the ground path's numbers stay the steps' `order`. One page load for the
// file; the click comes last.

import type { Page } from '@playwright/test';
import { test } from '@playwright/test';
import type { Report, Step } from '../../../../src/core/report/types.js';
import { effects } from '../../support/effects.js';
import { fixtures } from '../../support/mock-api.js';
import { selected, selectedFloor, sceneExpect as expect } from '../../support/scene.js';
import { cardOf, openPanel, stepsOf, stopCards } from '../../support/panel.js';

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let page: Page;
const report: Report = fixtures.reportWithSteps();
const KIND_CLASS = { add: 'a', del: 'd', ctx: 'c' } as const;
const GUTTER = { add: '+', del: '−', ctx: ' ' } as const;

const bySymbol = (name: string): Step => {
  const found = report.steps.find((one) => one.symbolId.endsWith(`#${name}`));
  if (found === undefined) throw new Error(`no step for ${name}`);
  return found;
};

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openPanel(page, report);
});
test.afterAll(async () => {
  await page.close();
});

test('panel/steps-card/why-and-inline-diff', async () => {
  // The first entry point, a migration and an unconnected removal.
  for (const one of [stepsOf(report, 'path')[0], stepsOf(report, 'migration')[0], bySymbol('roundMoney')]) {
    if (one === undefined) throw new Error('step missing');
    const card = cardOf(page, one);
    await expect(card.getByTestId('stop-why')).toHaveText(one.why);
    const lines = card.getByTestId('step-diff').locator('.l');
    await expect(lines).toHaveCount(one.diff.length);
    await expect(lines).toHaveClass(one.diff.map((line) => `l ${KIND_CLASS[line.kind]}`));
    expect(await lines.locator('.g').allTextContents()).toEqual(one.diff.map((line) => GUTTER[line.kind]));
    expect(await lines.allTextContents()).toEqual(one.diff.map((line) => `${GUTTER[line.kind]}${line.text}`));
  }
  // The removed function's diff is all removed lines.
  await expect(cardOf(page, bySymbol('roundMoney')).getByTestId('step-diff').locator('.l.d').first()).toBeVisible();
  await expect(cardOf(page, bySymbol('roundMoney')).getByTestId('stop-status')).toHaveText('removed');
});

test('panel/steps-card/findings-of-symbol-under-step', async () => {
  const expected: [string, string, string][] = [
    ['OrdersService.place', 'Total is not rounded before it is stored', 'semgrep'],
    ['ALTER TABLE orders', 'New column has no default for existing rows', 'claude'],
    ['OrdersRepo.markCancelled', 'Nothing calls markCancelled yet', 'claude'],
  ];
  for (const [name, title, source] of expected) {
    const pin = cardOf(page, bySymbol(name)).getByTestId('finding');
    await expect(pin).toHaveCount(1);
    await expect(pin.locator('.t')).toHaveText(title);
    await expect(pin.getByTestId('finding-source')).toHaveText(source);
  }
  // No other card carries a finding: the three are under their symbols only.
  await expect(stopCards(page).getByTestId('finding')).toHaveCount(3);
  await expect(cardOf(page, bySymbol('OrdersService.validate')).getByTestId('finding')).toHaveCount(0);
});

test('panel/steps-card/step-click-selects-building', async () => {
  // The ground path numbers the stops by the steps' order, every section included.
  const path = (await effects(page)).path;
  expect(path?.stops).toEqual([...report.steps].sort((a, b) => a.order - b.order).map((one) => one.order));

  const target = bySymbol('OrdersRepo.markCancelled');
  await cardOf(page, target).locator('.why').click();
  await expect.poll(() => selected(page)).toBe(target.fileId);
  await expect.poll(() => selectedFloor(page)).toBe(target.symbolId);
  await expect(page.getByTestId('file-view')).toBeVisible();
  await expect(page.getByTestId('file-view-file')).toHaveText(target.fileId);
  await page.getByTestId('file-view-back').click();
  await expect(page.getByTestId('file-view')).toBeHidden();
  await expect(cardOf(page, target)).toHaveClass(/\bon\b/);

  // A migration card: the migration's building.
  const migration = stepsOf(report, 'migration')[1];
  if (migration === undefined) throw new Error('no migration');
  await cardOf(page, migration).locator('.head').click();
  await expect.poll(() => selected(page)).toBe(migration.fileId);
  await expect.poll(() => selectedFloor(page)).toBe(migration.symbolId);
});
