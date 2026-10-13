// e2e/change/send-review-dialog (ADR-029, DC-134): "Send review to agent",
// opened from the review summary, shows exactly what the daemon previewed (the
// argv one item per line, the working tree, the session or why a new one, the
// permission note, the full summary); Send is enabled and focused only once
// the summary's end has been in view; any refusal is listed and Send is not
// offered; the dialog is modal and Esc gives focus back to its opener. From
// the top bar's "Send to agent" (DC-136) it opens directly, with the general
// note editable at its top: a saved note is previewed again, and a general
// note alone is a review that can be sent.

import { test } from '@playwright/test';
import { agentPreview } from '../../support/mock-api.js';
import { PLACE } from '../../support/panel.js';
import { openReview, openSendDialog, scrollSummaryToEnd, sendDialog, summaryDialog } from '../../support/review.js';
import { seedMark } from '../../support/review-api.js';
import { panelReport } from '../../support/panel.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

const report = panelReport();
const marks = [seedMark(report, 'symbol', PLACE, 'rewrite', { note: 'Split the discount out of place().' })];
const HOSTILE_TITLE = 'Add <img src=x onerror="window.pwned=1"> discounts';

test('change/send-review-dialog: shows-command', async ({ page }) => {
  const { api } = await openReview(page, { report, marks, wait: false });
  const base = agentPreview();
  const preview = agentPreview({ session: { sessionId: base.sessionId ?? '', title: HOSTILE_TITLE, firstAt: '2026-05-02T10:14:00.000Z', lastAt: '2026-05-02T11:02:00.000Z' } });
  api.agent(11).preview = preview;
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');

  const dialog = await openSendDialog(page);
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('heading')).toHaveText('Send review to agent');
  // One argv item per line, in order, as the daemon would run it.
  await expect(dialog.getByTestId('send-argv').locator('li')).toHaveText(preview.argv ?? []);
  await expect(dialog.getByTestId('send-cwd')).toHaveText('/work/order-desk');
  await expect(dialog.getByTestId('send-session')).toHaveAttribute('data-mode', 'resume');
  await expect(dialog.getByTestId('send-session-title')).toHaveText(HOSTILE_TITLE);
  await expect(dialog.getByTestId('send-session-range')).toHaveText(/2 May 2026, \d\d:\d\d–\d\d:\d\d/);
  await expect(dialog.getByTestId('send-permission')).toHaveText('The agent runs with your Claude Code permission settings for this project');
  await expect(dialog.getByTestId('send-timeout')).toHaveText('Stopped after 30 minutes');
  // The full summary, as text.
  expect(await dialog.getByTestId('send-summary').textContent()).toBe(preview.summary);
  await expect(dialog.locator('img')).toHaveCount(0);
  expect(await page.evaluate('window.pwned === undefined')).toBe(true);
  expect(api.agent(11).writes.map((write) => write.route)).toEqual(['preview']);

  // A new session with a permission mode: the reason and the mode are named.
  await page.keyboard.press('Escape');
  api.agent(11).preview = agentPreview({ mode: 'new', session: null, sessionId: null, newSessionReason: 'session-other-directory', permissionMode: 'acceptEdits' });
  await summaryDialog(page).getByTestId('summary-send').click();
  await expect(sendDialog(page).getByTestId('send-session')).toHaveText('New session: The latest linked session ran in another directory');
  await expect(sendDialog(page).getByTestId('send-permission')).toHaveText('Permission mode: acceptEdits');
});

test('change/send-review-dialog: requires-confirm-after-scroll', async ({ page }) => {
  const { api } = await openReview(page, { report, marks });
  const dialog = await openSendDialog(page);
  const send = dialog.getByTestId('send-run');
  // Offered but closed until the summary has been read to its end; focus starts on the summary.
  await expect(send).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(dialog.getByTestId('send-hint')).toHaveText('Read the summary to its end to send it');
  await expect(dialog.getByTestId('send-summary')).toBeFocused();
  await send.click({ force: true });
  expect(api.agent(11).writes.filter((write) => write.route === 'run')).toEqual([]);

  await scrollSummaryToEnd(page, dialog);
  await expect(send).toBeEnabled();
  await expect(send).toBeFocused();
  await expect(dialog.getByTestId('send-hint')).toBeHidden();

  await page.keyboard.press('Enter');
  // The run carries the preview's token and summary hash; both dialogs close and the status takes over.
  await expect(dialog).toBeHidden();
  await expect(summaryDialog(page)).toBeHidden();
  expect(api.agent(11).writes.filter((write) => write.route === 'run').map((write) => write.body)).toEqual([{ token: 'token-1', summaryHash: 'a'.repeat(64) }]);
  await expect(page.getByTestId('review-summary')).toBeFocused();
  await expect(page.getByTestId('agent-run-text')).toHaveText('Agent is working on 1 note');
});

test('change/send-review-dialog: refusal-reasons-shown', async ({ page }) => {
  const { api } = await openReview(page, { report, marks, wait: false });
  api.agent(11).preview = agentPreview({
    mode: null,
    argv: null,
    cwd: null,
    sessionId: null,
    session: null,
    token: null,
    refusals: [
      { code: 'agent-launch-disabled', message: 'agent launch is off (agentLaunch.enabled in settings.json)' },
      { code: 'no-working-tree', message: 'the change is not checked out in any working tree; diffcity never creates one or switches branches' },
    ],
  });
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  const dialog = await openSendDialog(page);
  const refusals = dialog.getByTestId('send-refusals');
  await expect(refusals).toBeVisible();
  await expect(refusals).toHaveAttribute('role', 'alert');
  await expect(refusals.getByTestId('send-refusal')).toHaveText([
    'agent launch is off (agentLaunch.enabled in settings.json)',
    'the change is not checked out in any working tree; diffcity never creates one or switches branches',
  ]);
  await expect(refusals.getByTestId('send-refusal').first()).toHaveAttribute('data-code', 'agent-launch-disabled');
  // No Send at all, even once the summary is read; the fallbacks stay.
  await expect(dialog.getByTestId('send-run')).toBeHidden();
  await scrollSummaryToEnd(page, dialog);
  await expect(dialog.getByTestId('send-run')).toBeHidden();
  await expect(dialog.getByTestId('send-hint')).toBeHidden();
  await expect(dialog.getByTestId('send-copy')).toBeEnabled();
  await expect(dialog.getByTestId('send-queue')).toBeEnabled();
  await expect(dialog.getByTestId('send-argv')).toHaveCount(0);

  // A run the daemon refuses after the preview (the token expired): its reason is listed and Send goes.
  await page.keyboard.press('Escape');
  api.agent(11).preview = agentPreview();
  api.agent(11).failNext = null;
  await summaryDialog(page).getByTestId('summary-send').click();
  await scrollSummaryToEnd(page, sendDialog(page));
  api.agent(11).failNext = { status: 409, code: 'token-invalid', message: 'the confirmation is unknown, used or expired; preview again' };
  await sendDialog(page).getByTestId('send-run').click();
  await expect(sendDialog(page).getByTestId('send-refusal')).toHaveText(['the confirmation is unknown, used or expired; preview again']);
  await expect(sendDialog(page).getByTestId('send-run')).toBeHidden();
  await expect(page.getByTestId('agent-run')).toBeHidden();
});

test('change/send-review-dialog: esc-returns-focus', async ({ page }) => {
  await openReview(page, { report, marks });
  const dialog = await openSendDialog(page);
  const opener = summaryDialog(page).getByTestId('summary-send');
  // Modal on top of the summary: Tab and Shift+Tab stay in the send dialog.
  const inside = (): Promise<boolean> => page.evaluate(`document.querySelector('[data-testid="send-dialog"]').contains(document.activeElement)`);
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  }
  // Keys typed in it never reach the screen.
  await page.keyboard.press('w');
  await expect(page.getByTestId('rewrite-dialog')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(summaryDialog(page)).toBeVisible();
  await expect(opener).toBeFocused();
  // The summary dialog holds focus again.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(`document.querySelector('[data-testid="summary-dialog"]').contains(document.activeElement)`)).toBe(true);

  // Cancel closes it the same way; then Esc closes the summary, focus back on its button.
  await opener.click();
  await sendDialog(page).getByTestId('send-cancel').click();
  await expect(sendDialog(page)).toBeHidden();
  await expect(opener).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(summaryDialog(page)).toBeHidden();
  await expect(page.getByTestId('review-summary')).toBeFocused();
});

test('change/send-review-dialog: send-from-top-bar-with-general-note-only', async ({ page }) => {
  // No mark and no note: the daemon has nothing to send.
  const { api } = await openReview(page, { report, wait: false });
  const agent = api.agent(11);
  agent.preview = agentPreview({ token: null, summary: '', summaryHash: 'c'.repeat(64), refusals: [{ code: 'nothing-to-send', message: 'nothing to send: no Needs rewrite mark and no general note' }] });
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');

  // The top bar's button opens the send dialog itself, not the summary.
  const button = page.getByTestId('send-to-agent');
  await expect(button).toHaveText('Send to agent');
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  await button.click();
  const dialog = sendDialog(page);
  await expect(dialog).toBeVisible();
  await expect(summaryDialog(page)).toHaveCount(0);
  await expect(dialog.getByTestId('send-refusal')).toHaveText(['nothing to send: no Needs rewrite mark and no general note']);
  await expect(dialog.getByTestId('send-run')).toBeHidden();
  const note = dialog.getByTestId('send-note');
  await expect(note).toHaveValue('');
  await expect(dialog.getByTestId('send-note-save')).toHaveAttribute('aria-disabled', 'true');

  // A general note, typed: not sent until saved, and the dialog says so.
  const NOTE = 'Split the discount rules out of the order service before merging.';
  await note.fill(NOTE);
  await expect(dialog.getByTestId('send-hint')).toHaveText('Save the note to send it: the summary below is what the agent gets');
  const summary = `# Review of ${report.meta.head}\n\n> ${NOTE}\n`;
  agent.preview = agentPreview({ summary, summaryHash: 'b'.repeat(64), token: 'token-2' });
  await dialog.getByTestId('send-note-save').click();
  await expect(dialog.getByTestId('send-note-status')).toHaveText('Note saved; the summary below now holds it');
  expect(api.review(11).writes.map((write) => write.body)).toEqual([{ note: NOTE }]);
  // Saved, the button waits without dropping focus out of the dialog: the screen's mark keys stay out of it.
  await expect(dialog.getByTestId('send-note-save')).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(`document.querySelector('[data-testid="send-dialog"]').contains(document.activeElement)`)).toBe(true);
  await page.keyboard.press('w');
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  expect(api.review(11).writes).toHaveLength(1);
  // Saved, then previewed again: the summary shown is the one the new hash and token stand for.
  await expect.poll(() => agent.writes.filter((write) => write.route === 'preview').length).toBe(2);
  expect(await dialog.getByTestId('send-summary').textContent()).toBe(summary);
  await expect(dialog.getByTestId('send-refusals')).toBeHidden();
  const send = dialog.getByTestId('send-run');
  await expect(send).toBeVisible();

  // Edited again without saving: Send closes until the note is saved or put back.
  await note.fill(`${NOTE} And rename it.`);
  await expect(send).toBeDisabled();
  await note.fill(NOTE);
  await scrollSummaryToEnd(page, dialog);
  await expect(send).toBeEnabled();

  // Esc still closes it, focus back on the top bar's button; opened again, the saved note is there.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  await expect(note).toHaveValue(NOTE);
  await scrollSummaryToEnd(page, dialog);
  await expect(send).toBeEnabled();

  // Sent with the new preview's token and hash; focus back on the top bar's button.
  await send.click();
  await expect(dialog).toBeHidden();
  expect(agent.writes.filter((write) => write.route === 'run').map((write) => write.body)).toEqual([{ token: 'token-2', summaryHash: 'b'.repeat(64) }]);
  await expect(button).toBeFocused();
  await expect(page.getByTestId('agent-run-text')).toHaveText('Agent is working on 1 note');
});

test('change/send-review-dialog: summary-readable-at-laptop-height', async ({ page }) => {
  // A laptop-sized window: the general note at the top of the dialog must not
  // squeeze the summary the reviewer has to read before Send (ADR-029) into a
  // line or two, nor push it under the dialog's buttons.
  await page.setViewportSize({ width: 1280, height: 800 });
  const { api } = await openReview(page, { report, marks, wait: false });
  const lines = Array.from({ length: 24 }, (_, index) => `- Rewrite step ${String(index + 1)} of the order desk`);
  const summary = `# Review of ${report.meta.head}\n\n${lines.join('\n')}\n`;
  api.agent(11).preview = agentPreview({ summary });
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');

  await page.getByTestId('send-to-agent').click();
  const dialog = sendDialog(page);
  await expect(dialog.getByTestId('send-note')).toBeVisible();
  const text = dialog.getByTestId('send-summary');
  await expect.poll(() => text.textContent()).toBe(summary);
  const height = await page.evaluate<number>(`document.querySelector('[data-testid="send-summary"]').clientHeight`);
  const box = await text.boundingBox();
  const actions = await dialog.getByTestId('send-cancel').locator('..').boundingBox();
  if (box === null || actions === null) throw new Error('the summary or the action row is not laid out');
  const geometry = { height, bottom: box.y + box.height, actionsTop: actions.y };
  // At least five lines of 12px/1.5 text in view, and not under the action row.
  expect(geometry.height).toBeGreaterThanOrEqual(90);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.actionsTop);
});
