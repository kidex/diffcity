// e2e/panel/hostile-text-is-inert (ADR-026): file paths, package paths, symbol
// names, `why`, step diffs and finding texts come from repositories and
// agents. The panel sets every one of them as text, so markup in them is shown
// as text, never becomes an element and never runs.

import { test } from '@playwright/test';
import { GUARD, finding } from '../../support/hud.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { CAN_PLACE, MAILER, openPanel, panel, panelReport, stopCards, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 90_000 });

const IMG = '<img src=x onerror=window.__pwned=1>';
const SCRIPT = '<script>window.__pwned=2</script>';
const SVG = '"><svg onload=window.__pwned=3>';

test('panel/hostile-text-is-inert', async ({ page }) => {
  const report = panelReport();
  const files = report.packages.flatMap((pkg) => pkg.files);
  const guard = files.find((file) => file.id === GUARD);
  const mailer = files.find((file) => file.id === MAILER);
  if (guard === undefined || mailer === undefined) throw new Error('fixture files missing');
  guard.path = `src/auth/${IMG}.ts`;
  mailer.path = `src/mail/${SVG}.ts`;
  const pkg = report.packages.find((entry) => entry.files.includes(guard));
  if (pkg === undefined) throw new Error('guard package missing');
  pkg.path = `src/${SVG}`;
  const symbol = guard.symbols.find((entry) => entry.id === CAN_PLACE);
  if (symbol === undefined) throw new Error('guard symbol missing');
  symbol.name = `canPlace${IMG}`;
  const first = report.steps[0];
  if (first === undefined) throw new Error('no step');
  first.why = `${SCRIPT} why ${IMG}`;
  first.diff = [
    { kind: 'del', text: SCRIPT },
    { kind: 'add', text: `${IMG}${SVG}` },
  ];
  report.findings = [
    finding('h-1', 'claude', '', { title: `${SCRIPT} change ${SVG}`, message: IMG }),
    finding('h-2', 'claude', guard.path, { title: `${IMG} guard`, message: `${SCRIPT}${SVG}`, symbolId: CAN_PLACE }),
    finding('h-3', 'semgrep', mailer.path, { title: SVG, message: IMG }),
  ];

  await openPanel(page, report);
  const dangerous = 'img, script, svg, [onerror], [onload]';
  const inert = async (): Promise<void> => {
    await expect(panel(page).locator(dangerous)).toHaveCount(0);
    expect(await page.evaluate('window.__pwned')).toBeUndefined();
  };

  // Stop cards: symbol, file, why, step diff, findings.
  const card = stopCards(page).first();
  await expect(card.getByTestId('stop-symbol')).toHaveText(`canPlace${IMG}`);
  await expect(card.getByTestId('stop-why')).toHaveText(`${SCRIPT} why ${IMG}`);
  await expect(card.getByTestId('step-diff')).toContainText(SCRIPT);
  await expect(card.getByTestId('step-diff')).toContainText(`${IMG}${SVG}`);
  await expect(card.getByTestId('finding').first()).toContainText(`${IMG} guard`);
  await inert();

  // Findings: the change-level group and the file groups.
  await tab(page, 'findings').click();
  const body = page.getByTestId('tab-findings-body');
  await expect(body).toContainText(`${SCRIPT} change ${SVG}`);
  await expect(body).toContainText(`src/auth/${IMG}.ts`);
  await expect(body).toContainText(`src/mail/${SVG}.ts`);
  await inert();

  // Outside the spec: the mailer.
  await tab(page, 'outside').click();
  await expect(page.getByTestId('tab-outside-body')).toContainText(`src/mail/${SVG}.ts`);
  await inert();

  // Symbols.
  await tab(page, 'symbols').click();
  const symbols = page.getByTestId('tab-symbols-body');
  await expect(symbols).toContainText(`canPlace${IMG}`);
  await expect(symbols).toContainText(`src/auth/${IMG}.ts`);
  await inert();

  // File view: path, package, stop, diff excerpt, findings.
  await tab(page, 'order').click();
  await card.dispatchEvent('click');
  const view = page.getByTestId('file-view');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('file-view-file')).toHaveText(`src/auth/${IMG}.ts`);
  await expect(view.getByTestId('file-view-package')).toHaveText(`src/${SVG}`);
  await expect(view.getByTestId('stop-why')).toHaveText(`${SCRIPT} why ${IMG}`);
  await expect(view.getByTestId('diff-excerpt')).toContainText(SCRIPT);
  await expect(view.getByTestId('file-view-stops')).toContainText(`canPlace${IMG}`);
  await inert();
});
