// e2e/change/visual-review-progress (SPEC.md section 6, ADR-028): the top bar's
// review progress with marks of every kind, and the city drawing them: a
// checked file with its check mark, a floor to rewrite, an outdated mark that
// looks unchecked. Linux CI baseline.

import { expect, test } from '@playwright/test';
import { GUARD, MIGRATION } from '../../support/hud.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { APPLY, PLACE } from '../../support/panel.js';
import { seedMark } from '../../support/review-api.js';
import { expectProgress } from '../../support/review.js';
import { linuxOnly, openVisualCity, prepareVisual, shot } from '../../support/visual.js';

linuxOnly();
test.describe.configure({ timeout: 120_000 });

test('change/visual-review-progress', async ({ page }) => {
  await prepareVisual(page);
  const report = fixtures.reportGolden();
  const marks = [
    seedMark(report, 'file', MIGRATION, 'checked'),
    seedMark(report, 'file', GUARD, 'good'),
    seedMark(report, 'symbol', PLACE, 'rewrite', { note: 'Validate the discount before saving.' }),
    seedMark(report, 'symbol', APPLY, 'checked', { state: 'outdated' }),
  ];
  await mockApi(page, { reports: { 11: report }, review: { marks, note: null } });
  await openVisualCity(page);
  await expectProgress(page, 'Everything that needs your eyes is checked');
  await expect(page.getByTestId('progress-rewrite')).toHaveText('1 to rewrite');
  await expect(page.getByTestId('progress-outdated')).toHaveText('1 changed since you checked it');
  await expect(page).toHaveScreenshot('review-progress.png', shot(page));
});
