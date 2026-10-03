// e2e/panel/tabs-and-counters: the reading panel has the header "Reading
// path" and four tabs with counters (Execution order, Findings, Outside the
// spec, Symbols); Session is hidden until phase 4. The counters come from the
// Report: stops, findings, files with inSpec false, touched symbols.

import { test } from '@playwright/test';
import { sceneExpect as expect } from '../../support/scene.js';
import { openPanel, panel, panelReport, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/tabs-and-counters', async ({ page }) => {
  const report = panelReport();
  await openPanel(page, report);
  const reading = panel(page);
  await expect(reading.getByRole('heading', { name: 'Reading path' })).toBeVisible();

  const symbols = report.packages.flatMap((pkg) => pkg.files).reduce((sum, file) => sum + file.symbols.filter((symbol) => symbol.status !== 'same').length, 0);
  await expect(tab(page, 'order')).toHaveText('Execution order5');
  await expect(tab(page, 'findings')).toHaveText('Findings5');
  await expect(tab(page, 'outside')).toHaveText('Outside the spec2');
  await expect(tab(page, 'symbols')).toHaveText(`Symbols${String(symbols)}`);
  await expect(reading.getByRole('button', { name: /Session/ })).toHaveCount(0);

  // Execution order is the tab on show; each tab button shows its own body.
  await expect(tab(page, 'order')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tab-order-body')).toBeVisible();
  for (const [id, body] of [
    ['findings', 'tab-findings-body'],
    ['outside', 'tab-outside-body'],
    ['symbols', 'tab-symbols-body'],
    ['order', 'tab-order-body'],
  ] as const) {
    await tab(page, id).click();
    await expect(tab(page, id)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId(body)).toBeVisible();
    await expect(tab(page, id === 'order' ? 'findings' : 'order')).toHaveAttribute('aria-pressed', 'false');
  }
});
