// e2e/panel/outside-spec-notice (SPEC.md 5.5, ADR-035): when the Report says
// why its spec marks nothing (`specNotice`: the spec names no touched symbol
// or file, or it is too large), the Outside the spec tab shows that text as
// is, with a zero counter, and no roof is labelled outside the spec. A file
// with the `spec` verdict gets the roof label "Outside the spec".

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { DISCOUNT, noSpecReport, openPanel, panelReport, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

const withNotice = (notice: string): Report => ({ ...noSpecReport(), specNotice: notice });

for (const notice of ['The spec names no touched symbol or file', 'The spec is larger than 256 KiB and was ignored']) {
  test(`panel/outside-spec-notice: "${notice}"`, async ({ page }) => {
    await openPanel(page, withNotice(notice));
    await expect(tab(page, 'outside')).toHaveText('Outside the spec0');
    await tab(page, 'outside').click();
    await expect(page.getByTestId('empty-outside')).toHaveText(notice);
    await expect(page.getByTestId('outside-file')).toHaveCount(0);
    await expect(page.locator('[data-testid="roof-label"].v-spec')).toHaveCount(0);
  });
}

test('panel/outside-spec-roof-label: a file with the spec verdict is labelled outside the spec in the city', async ({ page }) => {
  const report = panelReport();
  const file = report.packages.flatMap((pkg) => pkg.files).find((candidate) => candidate.path === DISCOUNT);
  if (file === undefined) throw new Error(`${DISCOUNT} is missing from the panel Report`);
  file.inSpec = false;
  file.verdict = 'spec';
  await openPanel(page, report);
  const roof = page.locator(`[data-testid="roof-label"][data-building="${DISCOUNT}"]`);
  await expect(roof).toHaveClass(/\bv-spec\b/);
  await expect(roof).toContainText('Outside the spec');
});
