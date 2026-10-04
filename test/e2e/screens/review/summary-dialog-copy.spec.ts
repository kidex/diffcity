// e2e/review/summary-dialog-copy (SPEC.md section 6, "Review marks"; ADR-028):
// the review summary dialog shows the daemon's markdown as plain text (never
// rendered), a general note that is saved and reaches the summary, Copy to
// clipboard, and where sending it to the agent will be (phase 4). The dialog is
// modal: focus goes in and stays in, Esc closes it and focus goes back.

import { test } from '@playwright/test';
import { SERVICE } from '../../support/hud.js';
import { panelReport, PLACE } from '../../support/panel.js';
import { openReview, summaryDialog } from '../../support/review.js';
import { seedMark } from '../../support/review-api.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

// Markup in a note must come out as text.
const HOSTILE = 'Handle <b>bold</b> and <img src=x onerror="window.pwned=1"> in the total.';

test('review/summary-dialog-copy', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL ?? 'http://127.0.0.1:4507').origin });
  const report = panelReport();
  const { api } = await openReview(page, {
    report,
    marks: [seedMark(report, 'symbol', PLACE, 'rewrite', { note: HOSTILE, lines: { side: 'new', start: 31, end: 33 } })],
    note: 'Ship after the rewrite below.',
  });
  const mock = api.review(11);

  const trigger = page.getByTestId('review-summary');
  await trigger.click();
  const dialog = summaryDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('heading')).toHaveText('Review summary');

  // The daemon's markdown, as text: the structure of ADR-028 is there, the markup is not rendered.
  const text = dialog.getByTestId('summary-text');
  await expect(text).toContainText('## Needs rewrite (1)');
  await expect(text).toContainText(`### ${SERVICE}`);
  await expect(text).toContainText('Ship after the rewrite below.');
  await expect(text).toContainText('<b>bold</b>');
  await expect(text).toContainText('lines 31–33');
  await expect(text.locator('b, img, h2, h3, script')).toHaveCount(0);
  await expect(dialog.locator('img')).toHaveCount(0);
  expect(await page.evaluate('window.pwned === undefined')).toBe(true);
  await expect(dialog.getByTestId('summary-phase')).toHaveText('Sending it to the agent arrives in phase 4');

  // Copy puts exactly the markdown on the clipboard.
  const shown = (await text.textContent()) ?? '';
  expect(shown).toMatch(/^# Review of /);
  await dialog.getByTestId('summary-copy').click();
  await expect(dialog.getByTestId('summary-copy-status')).toHaveText('Copied');
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(shown);

  // The general note is saved through setNote and the summary is read again with it.
  await dialog.getByTestId('summary-note').fill('Hold the merge until the guard is rewritten.');
  await dialog.getByTestId('summary-note-save').click();
  await expect(dialog.getByTestId('summary-note-status')).toHaveText('Note saved');
  await expect(text).toContainText('Hold the merge until the guard is rewritten.');
  expect(mock.note).toBe('Hold the merge until the guard is rewritten.');
  expect(mock.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/note', body: { note: 'Hold the merge until the guard is rewritten.' } });

  // Modal: Tab and Shift+Tab stay inside, whatever the number of presses.
  const inside = (): Promise<boolean> => page.evaluate(`document.querySelector('[data-testid="summary-dialog"]').contains(document.activeElement)`);
  for (let i = 0; i < 9; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 9; i += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  }
  // Keys typed in the dialog do not reach the screen: W in the note field is a letter, not "Needs rewrite".
  await dialog.getByTestId('summary-note').focus();
  await page.keyboard.type('w');
  await expect(dialog.getByTestId('rewrite-dialog')).toHaveCount(0);

  // Esc closes it and focus returns to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Reopened, it reads the current state again; the backdrop click closes it too.
  await trigger.click();
  await expect(summaryDialog(page).getByTestId('summary-text')).toContainText('Hold the merge until the guard is rewritten.');
  await page.getByTestId('summary-dialog-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(summaryDialog(page)).toBeHidden();
});
