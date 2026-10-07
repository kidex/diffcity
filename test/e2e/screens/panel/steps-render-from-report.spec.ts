// e2e/panel/steps-render-from-report: the Execution order tab has one card per
// step of the Report, in order. A card has a rail and a node, the symbol, the
// file, the file's verdict tag and the status tag, `why`, the inline diff with
// its gutters, and the findings anchored to the symbol with their source and
// the "Ask agent to fix" and "Mark as intended" buttons (the SPA has a FindingsPort).

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { attributesOf, openPanel, panelReport, stopCards } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/steps-render-from-report', async ({ page }) => {
  const report = panelReport();
  await openPanel(page, report);
  const cards = stopCards(page);
  await expect(cards).toHaveCount(report.steps.length);
  await expect(cards.locator('[data-testid="stop-symbol"]')).toHaveText(['OrderGuard.canPlace', 'OrdersService.place', 'OrdersService.applyDiscount', 'ALTER TABLE orders', 'send']);
  expect(await attributesOf(page, 'stop-card', 'data-order')).toEqual(['1', '2', '3', '4', '5']);

  const first = cards.first();
  await expect(first.locator('.rail')).toHaveCount(1);
  await expect(first.locator('.node')).toHaveCount(1);
  await expect(first.getByTestId('stop-file')).toHaveText('order.guard.ts');
  await expect(first.getByTestId('stop-file')).toHaveAttribute('title', 'src/auth/order.guard.ts');
  await expect(first.getByTestId('stop-verdict')).toHaveText('Needs your eyes');
  await expect(first.getByTestId('stop-status')).toHaveText('signature');
  await expect(first.getByTestId('stop-why')).toHaveText('The entry point: the guard now also checks the owner.');
  // The inline diff: gutters and one line per DiffLine.
  const lines = first.getByTestId('step-diff').locator('.l');
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(1)).toHaveClass(/\bd\b/);
  await expect(lines.nth(1).locator('.g')).toHaveText('−');
  await expect(lines.nth(2)).toHaveClass(/\ba\b/);
  await expect(lines.nth(2).locator('.g')).toHaveText('+');
  await expect(lines.nth(2)).toContainText('order.owner === user.id');

  // The finding anchored to the symbol, with its source and its two buttons.
  const pin = first.getByTestId('finding');
  await expect(pin).toHaveCount(1);
  await expect(pin).toContainText('Guard skips the owner check on cancel');
  await expect(pin.getByTestId('finding-source')).toHaveText('claude');
  for (const name of ['Ask agent to fix', 'Mark as intended']) {
    const button = pin.getByRole('button', { name: `${name}: Guard skips the owner check on cancel` });
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveAttribute('title', 'Arrives in a later version');
  }

  // The second card shows the semgrep finding but not the fixed eslint one it shares a file with.
  await expect(cards.nth(1).getByTestId('finding')).toHaveCount(1);
  await expect(cards.nth(1).getByTestId('finding-source')).toHaveText('semgrep');
  // A step without an excerpt has no code block.
  await expect(cards.nth(4).getByTestId('step-diff')).toHaveCount(0);
});
