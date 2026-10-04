// e2e/a11y/live-update-keeps-focus-in-list (DC-89): without WebGL, a live
// Report update (SSE snapshot) that keeps the focused file leaves the focus on
// that file's button, whether the list is redrawn (another row changed) or
// left alone (nothing in it changed).

import { expect, test } from '@playwright/test';
import { GUARD, SERVICE } from '../../support/hud.js';
import { mockApi } from '../../support/mock-api.js';
import { panelReport } from '../../support/panel.js';
import { withoutWebgl } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test('a11y/live-update-keeps-focus-in-list', async ({ page }, testInfo) => {
  await tagClient(page, testInfo.testId);
  await withoutWebgl(page);
  const reports = { 11: panelReport() };
  await mockApi(page, { reports });
  await page.goto('/#/change/11');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');

  const row = (path: string) => page.locator(`[data-testid="touched-file"][data-path="${path}"]`);
  const button = row(SERVICE).getByRole('button', { name: SERVICE });
  await button.focus();
  await expect(button).toBeFocused();
  const focusedPath = (): Promise<string | null> =>
    page.evaluate(`document.activeElement?.closest('[data-testid="touched-file"]')?.getAttribute('data-path') ?? null`);

  const before = (await row(GUARD).getByTestId('file-verdict').textContent()) ?? '';

  // 1. The update changes another file's text in the list: the list is redrawn, the focus stays on the same file.
  const changed = panelReport();
  const other = changed.packages.flatMap((pkg) => pkg.files).find((file) => file.path === GUARD);
  if (other === undefined) throw new Error('guard missing');
  other.verdict = other.verdict === 'ok' ? 'eyes' : 'ok';
  reports[11] = changed;
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'bbbbbbb' });
  await expect(row(GUARD).getByTestId('file-verdict')).not.toHaveText(before);
  await expect.poll(focusedPath).toBe(SERVICE);
  await expect(row(SERVICE).getByRole('button', { name: SERVICE })).toBeFocused();

  // 2. An update that changes nothing in the list: same button, still focused.
  await page.evaluate(`document.activeElement.setAttribute('data-probe', 'same-node')`);
  await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: 'ccccccc' });
  await page.waitForTimeout(500);
  expect(await focusedPath()).toBe(SERVICE);
  await expect(row(SERVICE).getByRole('button', { name: SERVICE })).toBeFocused();
  await expect(row(SERVICE).getByRole('button', { name: SERVICE })).toHaveAttribute('data-probe', 'same-node');
});
