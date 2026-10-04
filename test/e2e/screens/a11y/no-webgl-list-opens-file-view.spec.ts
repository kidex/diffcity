// e2e/a11y/no-webgl-list-opens-file-view (DC-89): without WebGL the screen is
// still a review path. The touched files are listed by package with their
// status and verdict; a click or Enter on a file opens the file view in the
// reading panel, with the full diff when the screen has a DiffPort and the
// mark controls when it has a ReviewPort; a mark made there is written.

import { expect, test } from '@playwright/test';
import { serveGuard } from '../../support/fileview.js';
import { GUARD, SERVICE } from '../../support/hud.js';
import { mockApi } from '../../support/mock-api.js';
import { panelReport } from '../../support/panel.js';
import { fileView, lastWrite, viewButton } from '../../support/review.js';
import { withoutWebgl } from '../../support/scene.js';

test('a11y/no-webgl-list-opens-file-view', async ({ page }) => {
  const report = panelReport();
  await withoutWebgl(page);
  const api = await mockApi(page, { reports: { 11: report }, diff: serveGuard(), review: { marks: [] } });
  await page.goto('/#/change/11');

  // The list: files grouped by package, each with its status and verdict.
  const packages = page.getByTestId('touched-package');
  const touched = report.packages.map((pkg) => ({ pkg, files: pkg.files.filter((file) => file.status !== 'same') })).filter((group) => group.files.length > 0);
  await expect(packages).toHaveCount(touched.length);
  await expect(packages.locator('.pkg-path')).toHaveText(touched.map(({ pkg }) => pkg.path));
  const guardRow = page.locator(`[data-testid="touched-file"][data-path="${GUARD}"]`);
  await expect(guardRow.getByTestId('file-verdict')).toHaveText('Needs your eyes');
  await expect(guardRow.getByTestId('file-status')).toBeVisible();
  await expect(page.getByTestId('reading-panel')).toBeVisible();
  await expect(fileView(page)).toBeHidden();

  // A click opens the file view with the full diff and the mark controls.
  await guardRow.getByRole('button', { name: GUARD }).click();
  await expect(fileView(page)).toBeVisible();
  await expect(page.getByTestId('diff-view')).toBeVisible();
  await expect(page.getByTestId('diff-row').first()).toBeVisible();
  await expect(guardRow).toHaveClass(/\bon\b/);
  await expect(guardRow.getByRole('button', { name: GUARD })).toHaveAttribute('aria-current', 'true');
  await expect(viewButton(page, 'checked')).toBeVisible();

  // The mark goes through the review port.
  await viewButton(page, 'checked').click();
  await expect.poll(() => api.review(11).writes.length).toBe(1);
  expect(lastWrite(api)).toMatchObject({ method: 'PUT', body: { target: { kind: 'file', id: GUARD }, mark: 'checked' } });
  await expect(fileView(page).getByTestId('mark-current')).toHaveText('Checked');

  // The key does the same on the open file; Esc returns to the tabs.
  await page.keyboard.press('u');
  await expect.poll(() => api.review(11).writes.length).toBe(2);
  await page.keyboard.press('Escape');
  await expect(fileView(page)).toBeHidden();
  await expect(page.getByTestId('tab-order')).toBeVisible();

  // Enter on a focused file opens it too, and J moves the open file on.
  const service = page.locator(`[data-testid="touched-file"][data-path="${SERVICE}"]`).getByRole('button', { name: SERVICE });
  await service.focus();
  await page.keyboard.press('Enter');
  await expect(fileView(page)).toBeVisible();
  await expect(fileView(page)).toContainText('orders.service.ts');
  await expect(page.locator(`[data-testid="touched-file"][data-path="${SERVICE}"]`)).toHaveClass(/\bon\b/);
  await page.keyboard.press(']');
  await expect(page.locator('[data-testid="touched-file"].on')).toHaveCount(1);
  await expect(page.locator('[data-testid="touched-file"].on')).not.toHaveAttribute('data-path', SERVICE);
});
