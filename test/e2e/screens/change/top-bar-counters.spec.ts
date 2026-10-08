// e2e/change/top-bar-counters (ADR-026, SPEC.md section 6): the top bar of the
// change screen shows the counters of files and symbols by status from the
// Report's summary, the "N files need your eyes" badge, the Export button,
// visible and disabled, and Approve, closed while there are no review marks to
// read the gate from (DC-116). The breadcrumb (repo, branch against
// base, commits and time) stays the shell's: the bar does not repeat it.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { withoutWebgl } from '../../support/scene.js';

test('change/top-bar-counters', async ({ page }) => {
  await withoutWebgl(page);
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await page.goto('/#/change/11');

  const bar = page.getByTestId('hud-bar');
  await expect(bar).toBeVisible();
  const report = fixtures.reportGolden();
  const { summary } = report;
  await expect(bar.getByTestId('stat-files')).toHaveText(`${String(summary.files)}files`);
  await expect(bar.getByTestId('stat-add')).toHaveText(`${String(summary.byStatus.add)}added`);
  await expect(bar.getByTestId('stat-mod')).toHaveText(`${String(summary.byStatus.mod)}modified`);
  await expect(bar.getByTestId('stat-sig')).toHaveText(`${String(summary.byStatus.sig)}signature`);
  await expect(bar.getByTestId('stat-del')).toHaveText(`${String(summary.byStatus.del)}removed`);
  await expect(bar.getByTestId('eyes-badge')).toHaveText(`${String(summary.byVerdict.eyes)} files need your eyes before merge`);

  // Export PlantUML: visible, disabled, with the reason.
  const exportButton = bar.getByRole('button', { name: 'Export PlantUML' });
  await expect(exportButton).toBeVisible();
  await expect(exportButton).toBeDisabled();
  await expect(exportButton).toHaveAttribute('title', 'Arrives in a later version');
  await expect(bar.getByTestId('export-plantuml')).toHaveCount(1);
  await exportButton.click({ force: true });
  // Approve: the mock has no review state for the change, so the gate stays closed.
  const approve = bar.getByRole('button', { name: 'Approve when tier 1 is read' });
  await expect(approve).toBeVisible();
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute('title', 'The review marks of this change have not loaded yet');
  await expect(bar.getByTestId('approve')).toHaveCount(1);
  await approve.click({ force: true });
  await expect(bar.getByTestId('approve-confirm')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/change\/11$/);

  // The breadcrumb is the shell's, once: repo, branch against base, commits and time.
  const crumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumb).toContainText('feature/order-discounts');
  await expect(crumb).toContainText('against');
  await expect(crumb).toContainText('main');
  await expect(crumb).toContainText(/2 commits, \d+ days? ago/);
  await expect(page.getByTestId('hud-crumb')).toHaveCount(0);
  await expect(crumb.getByText('against')).toHaveCount(1);
});
