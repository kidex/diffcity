// Proof video for DC-105 (phase 4 T8): the reading panel's sections. The real
// daemon from dist/, in a temporary home, collects the order-discounts golden
// change; the Execution order tab lists its steps under three headings
// (Execution path, Migrations, Unconnected), a card shows its why and inline
// diff, J and K cross from the path into the migrations and on into
// Unconnected, and a click on a card selects its building.
// Recorded by `npm run proof -- DC-105`.

import type { Locator, Page } from '@playwright/test';
import type { Step } from '../../../src/core/report/types.js';
import { stubEnv, trackScenario } from '../support/change-daemon.js';
import { cardOf, stepName, stopSection } from '../support/panel.js';
import { criterion, expect, HOLD_MS, test, titleCard } from '../support/proof.js';
import { selected, selectedFloor, waitReady } from '../support/scene.js';

/** Puts `node` at the top of the panel's list, so the video shows it. */
async function showAtTop(page: Page, node: Locator): Promise<void> {
  await node.scrollIntoViewIfNeeded();
  const box = await node.boundingBox();
  const list = await page.getByTestId('panel-scroll').boundingBox();
  if (box === null || list === null) return;
  await page.evaluate(`document.querySelector('[data-testid="panel-scroll"]').scrollTop += ${String(Math.round(box.y - list.y - 8))}`);
}

test('DC-105: the reading panel lists the real steps under Execution path, Migrations and Unconnected', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-105: the reading panel, by section', [
    'The real daemon from dist/, in a temporary home, on the invented order-discounts change.',
    'Three headings: Execution path, Migrations, Unconnected; each card with its why and inline diff.',
    'J and K cross the sections; a click on a card selects its building.',
  ]);
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  const report = await tracked.report();
  const of = (section: NonNullable<Step['section']>): Step[] =>
    report.steps.filter((one) => (one.section ?? 'path') === section).sort((a, b) => a.order - b.order);
  const path = of('path');
  const migrations = of('migration');
  const unconnected = of('unconnected');
  const at = async (one: Step | undefined): Promise<void> => {
    if (one === undefined) throw new Error('step missing');
    await expect.poll(() => selectedFloor(page)).toBe(one.symbolId);
    await expect(cardOf(page, one)).toHaveClass(/\bon\b/);
  };

  await criterion(page, '1. Three section headings, each with its number of stops', async () => {
    await page.goto(tracked.url);
    await waitReady(page);
    await expect(page.getByTestId('section-label')).toHaveText(['Execution path', 'Migrations', 'Unconnected']);
    await expect(page.getByTestId('section-count')).toHaveText([path, migrations, unconnected].map((steps) => String(steps.length)));
    await page.waitForTimeout(HOLD_MS);
    await showAtTop(page, stopSection(page, 'migration'));
    await page.waitForTimeout(HOLD_MS);
    await showAtTop(page, stopSection(page, 'path'));
  }, `${String(path.length)} on the path, ${String(migrations.length)} migrations, ${String(unconnected.length)} unconnected`);

  const entry = path[0];
  if (entry === undefined) throw new Error('no path step');
  await criterion(page, '2. A step card: its why and its inline diff', async () => {
    const card = cardOf(page, entry);
    await expect(card.getByTestId('stop-why')).toHaveText(entry.why);
    await expect(card.getByTestId('step-diff').locator('.l')).toHaveCount(entry.diff.length);
    await expect(card.getByTestId('step-diff').locator('.l.a').first()).toBeVisible();
  }, `${stepName(entry)}: ${entry.why}`);

  await criterion(page, '3. J walks the path, crosses into Migrations, then into Unconnected; K walks back', async () => {
    await page.keyboard.press('j');
    await at(path[0]);
    for (let i = 1; i < path.length; i += 1) {
      await page.keyboard.press('j');
      await page.waitForTimeout(120);
    }
    await at(path.at(-1));
    await page.waitForTimeout(HOLD_MS / 2);
    await page.keyboard.press('j');
    await at(migrations[0]);
    await page.waitForTimeout(HOLD_MS / 2);
    for (let i = 1; i < migrations.length; i += 1) await page.keyboard.press('j');
    await at(migrations.at(-1));
    await page.waitForTimeout(HOLD_MS / 2);
    await page.keyboard.press('j');
    await at(unconnected[0]);
    await expect(stopSection(page, 'unconnected').locator('.step.on')).toHaveCount(1);
    await page.waitForTimeout(HOLD_MS / 2);
    await page.keyboard.press('k');
    await at(migrations.at(-1));
  }, `path ${String(path.at(-1)?.order)} -> migration ${String(migrations[0]?.order)} -> unconnected ${String(unconnected[0]?.order)}`);

  const target = unconnected.at(-1);
  if (target === undefined) throw new Error('no unconnected step');
  await criterion(page, '4. A click on an Unconnected card selects its building', async () => {
    const card = cardOf(page, target);
    await showAtTop(page, card);
    await page.waitForTimeout(HOLD_MS / 2);
    await card.locator('.why').click();
    await expect.poll(() => selected(page)).toBe(target.fileId);
    await expect.poll(() => selectedFloor(page)).toBe(target.symbolId);
    await expect(page.getByTestId('file-view-file')).toHaveText(target.fileId);
  }, `${stepName(target)} in ${target.fileId}`);
});
