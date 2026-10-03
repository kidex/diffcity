// e2e/panel/update-keeps-tab-and-file-view (ADR-026): a live update keeps the
// tab, the selection and the open file view, and shows the new Report's
// texts; when the open file is no longer in the Report the file view closes
// and the toast says why.

import { test } from '@playwright/test';
import { GUARD, SERVICE } from '../../support/hud.js';
import { project, stats, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';
import { openPanel, panelReport, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 90_000 });

test('panel/update-keeps-tab-and-file-view', async ({ page }, testInfo) => {
  await tagClient(page, testInfo.testId);
  const reports = await openPanel(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const view = page.getByTestId('file-view');

  // The tab survives an update.
  await tab(page, 'findings').click();
  const next = panelReport();
  next.findings = next.findings.slice(0, 3);
  reports[11] = next;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'aaaaaaa' });
  await expect(tab(page, 'findings')).toHaveText('Findings3');
  await expect(tab(page, 'findings')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tab-findings-body')).toBeVisible();

  // The file view survives an update, with the new texts.
  const guard = await project(page, GUARD);
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(view.getByTestId('file-view-file')).toHaveText(GUARD);
  const changed = panelReport();
  const step = changed.steps[0];
  if (step === undefined) throw new Error('no step');
  step.why = 'Reworded after the update.';
  reports[11] = changed;
  const frames = (await stats(page)).frames;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'bbbbbbb' });
  await expect.poll(async () => (await stats(page)).frames).toBeGreaterThan(frames);
  await expect(view.getByTestId('stop-why')).toHaveText('Reworded after the update.');
  await expect(view.getByTestId('file-view-file')).toHaveText(GUARD);
  await expect(page.getByTestId('city')).toHaveAttribute('data-selected', GUARD);
  await page.getByTestId('file-view-back').click();
  await expect(tab(page, 'findings')).toHaveAttribute('aria-pressed', 'true');

  // The open file leaves the Report: the file view closes and the toast says so.
  const service = await project(page, SERVICE);
  await page.mouse.click(service.x, service.y);
  await waitForCityAttribute(page, 'data-selected', SERVICE);
  await expect(view).toBeVisible();
  const gone = panelReport();
  const services = gone.packages.find((pkg) => pkg.path === 'src/services/orders');
  if (services === undefined) throw new Error('services package missing');
  services.files = services.files.filter((file) => file.id !== SERVICE);
  gone.steps = gone.steps.filter((entry) => entry.fileId !== SERVICE);
  gone.findings = gone.findings.filter((entry) => entry.file !== SERVICE);
  reports[11] = gone;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'ccccccc' });
  await expect(view).toBeHidden();
  await expect(page.getByTestId('toast')).toHaveText(`${SERVICE} is no longer in this change`);
  await expect(tab(page, 'findings')).toBeVisible();
  await expect(tab(page, 'order')).toHaveText('Execution order3');
});
