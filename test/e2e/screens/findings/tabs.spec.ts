// e2e/findings/tabs (DC-108): the Findings and Outside the spec tabs show the
// Report's data. Every source of a finding is listed beside it (a merged
// entry has two), with the footer naming them all; the Outside the spec tab
// lists the files the Report says are outside it, and says when the change
// has no spec to compare against. Nothing is computed: `inSpec` is the Report's.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { CONTROLLER, DTO, FIXED, HIGH, INTENDED, MAILER, MED, mixedReport, openFindings, REPO, RULE, SERVICE, tabCard } from '../../support/findings.js';
import { recomputeVerdicts } from '../../support/findings-api.js';
import { attributesOf } from '../../support/panel.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('findings/tabs/sources-listed', async ({ page }) => {
  await openFindings(page);
  await expect(page.getByTestId('count-findings')).toHaveText('5');
  await page.getByTestId('tab-findings').click();
  // By file in the Report's order, open first within a file.
  await expect(page.getByTestId('finding-group')).toHaveCount(4);
  expect(await attributesOf(page, 'finding-group', 'data-group')).toEqual([CONTROLLER, REPO, MAILER, SERVICE]);
  // The Execution order tab is not in the page while the Findings tab shows: these are the tab's cards.
  expect(await attributesOf(page, 'finding', 'data-finding')).toEqual([RULE, FIXED, INTENDED, HIGH, MED]);

  // Every source beside the finding, as a list.
  const merged = tabCard(page, HIGH);
  await expect(merged.getByRole('list', { name: 'Sources' }).getByRole('listitem')).toHaveText(['claude', 'semgrep']);
  await expect(tabCard(page, MED).getByRole('list', { name: 'Source' }).getByRole('listitem')).toHaveText(['semgrep']);
  await expect(tabCard(page, RULE).getByTestId('finding-source')).toHaveText(['rule:file-size']);
  await expect(tabCard(page, FIXED).getByTestId('finding-source')).toHaveText(['eslint']);
  // States: open has none shown, the others say theirs.
  await expect(tabCard(page, INTENDED).getByTestId('finding-state')).toHaveText('intended');
  await expect(tabCard(page, FIXED).getByTestId('finding-state')).toHaveText('fixed');
  await expect(tabCard(page, FIXED).locator('button')).toHaveCount(0);
  // The footer names every source once, the merged one's second source included.
  await expect(page.getByTestId('panel-sources')).toHaveText('Findings from Claude, semgrep, rules, eslint');
});

test('findings/tabs/outside-tab-content', async ({ page }) => {
  // The Report says the DTO and the mailer are outside the spec (rendering only: the daemon decides it).
  const report: Report = mixedReport();
  for (const file of report.packages.flatMap((pkg) => pkg.files)) file.inSpec = file.id === DTO || file.id === MAILER ? false : file.status === 'same' ? null : true;
  recomputeVerdicts(report);
  await openFindings(page, { report });
  await expect(page.getByTestId('count-outside')).toHaveText('2');
  await page.getByTestId('tab-outside').click();
  const files = page.getByTestId('outside-file');
  await expect(files).toHaveCount(2);
  await expect(files.getByTestId('group-file')).toHaveText([/orders\.dto\.ts/, /mailer\.ts/]);
  await expect(files.first().locator('.tag.verdict')).toHaveClass(/\bspec\b/);
  await expect(page.getByTestId('empty-outside')).toHaveCount(0);
  // A click opens the file's view.
  await files.first().getByTestId('group-file').click();
  await expect(page.getByTestId('file-view-file')).toHaveText(DTO);
});

test('findings/tabs/outside-tab-no-root-notice', async ({ page }) => {
  // No spec on this change: `inSpec` is null on every file, as the daemon serves it until spec scope exists.
  await openFindings(page);
  await expect(page.getByTestId('count-outside')).toHaveText('0');
  await page.getByTestId('tab-outside').click();
  await expect(page.getByTestId('empty-outside')).toHaveText('This change has no spec to compare against');
  await expect(page.getByTestId('outside-file')).toHaveCount(0);
});
