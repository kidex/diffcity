// Proof video for DC-97 (phase 4 T4): the execution path computed by the real
// daemon. The real daemon from dist/, in a temporary home, collects the
// order-discounts golden change; the reading panel lists its real steps: the
// execution path from the entry points, then the migrations, then the
// unconnected symbols, each with its `why` and inline diff, and J/K walk them.
// Recorded by `npm run proof -- DC-97`.

import type { Locator } from '@playwright/test';
import type { Step } from '../../../src/core/report/types.js';
import { stubEnv, trackScenario } from '../support/change-daemon.js';
import { stopCards } from '../support/panel.js';
import { criterion, expect, HOLD_MS, test, titleCard } from '../support/proof.js';
import { selected, selectedFloor, waitReady } from '../support/scene.js';

const symbolName = (step: Step): string => step.symbolId.slice(step.symbolId.indexOf('#') + 1);

/** Brings a card into view in the panel's list. */
async function showCard(card: Locator): Promise<void> {
  await card.scrollIntoViewIfNeeded();
}

test('DC-97: the reading panel walks the real execution path of a golden change', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-97: the execution path, computed by the daemon', [
    'The real daemon from dist/, in a temporary home.',
    'order-discounts: an invented repo with a NestJS controller, a service, a repo and a migration.',
    'Steps in order: execution path, then migrations, then unconnected symbols, each with why and inline diff.',
  ]);
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  const report = await tracked.report();
  const steps = report.steps;
  const first = (section: Step['section']): Step => {
    const found = steps.find((step) => (step.section ?? 'path') === section);
    if (found === undefined) throw new Error(`no ${String(section)} step`);
    return found;
  };
  const cards = stopCards(page);

  await criterion(page, '1. The Report carries real steps; the panel shows one card per step, in order', async () => {
    await page.goto(tracked.url);
    await waitReady(page);
    expect(steps.length).toBeGreaterThan(10);
    await expect(cards).toHaveCount(steps.length);
    await expect(cards.locator('[data-testid="stop-symbol"]')).toHaveText(steps.map(symbolName));
  }, `${String(steps.length)} steps from the daemon`);

  const entry = first('path');
  await criterion(page, '2. Execution path: the first entry point, its why and its inline diff', async () => {
    const card = cards.nth(entry.order - 1);
    await showCard(card);
    await expect(card.getByTestId('stop-why')).toHaveText(entry.why);
    await expect(card.getByTestId('step-diff').locator('.l')).toHaveCount(entry.diff.length);
  }, `${symbolName(entry)}: ${entry.why}`);

  await criterion(page, '3. J and K walk the steps; the city selects each one', async () => {
    await page.keyboard.press('j');
    await expect.poll(() => selectedFloor(page)).toBe(steps[0]?.symbolId);
    await expect(cards.nth(0)).toHaveClass(/\bon\b/);
    await page.waitForTimeout(HOLD_MS / 2);
    await page.keyboard.press('j');
    await expect.poll(() => selectedFloor(page)).toBe(steps[1]?.symbolId);
    await expect(cards.nth(1)).toHaveClass(/\bon\b/);
    await page.waitForTimeout(HOLD_MS / 2);
    await page.keyboard.press('j');
    await expect.poll(() => selectedFloor(page)).toBe(steps[2]?.symbolId);
    await expect(cards.nth(2)).toHaveClass(/\bon\b/);
    await page.waitForTimeout(HOLD_MS / 2);
    await page.keyboard.press('k');
    await expect.poll(() => selectedFloor(page)).toBe(steps[1]?.symbolId);
    await expect.poll(() => selected(page)).toBe(steps[1]?.fileId);
    await expect(cards.nth(1)).toHaveClass(/\bon\b/);
  });

  const migration = first('migration');
  await criterion(page, '4. Migrations: touched SQL statements come after the path', async () => {
    const card = cards.nth(migration.order - 1);
    await showCard(card);
    await expect(card.getByTestId('stop-symbol')).toHaveText(symbolName(migration));
    await expect(card.getByTestId('stop-why')).toHaveText(migration.why);
    await expect(card.getByTestId('step-diff').locator('.l.a').first()).toBeVisible();
  }, `step ${String(migration.order)}: ${migration.why}`);

  const unconnected = first('unconnected');
  await criterion(page, '5. Unconnected: symbols no entry point reaches close the list', async () => {
    expect(unconnected.order).toBeGreaterThan(migration.order);
    const card = cards.nth(unconnected.order - 1);
    await showCard(card);
    await expect(card.getByTestId('stop-symbol')).toHaveText(symbolName(unconnected));
    await expect(card.getByTestId('stop-why')).toHaveText(unconnected.why);
    await card.click();
    await expect.poll(() => selectedFloor(page)).toBe(unconnected.symbolId);
  }, `step ${String(unconnected.order)} of ${String(steps.length)}: ${symbolName(unconnected)}, ${unconnected.why}`);
});
