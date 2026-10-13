// e2e/approve/gate (DC-116, ADR-036, SPEC.md section 6): Approve in the top bar
// against the mocked approve route. Plain Approve is offered when the daemon's
// review progress says every touched tier 1 file has a current mark; a click
// asks to confirm inline, Confirm sends POST, and the bar shows the approved
// badge with the short head and Undo approve (DELETE). While tier 1 files are
// unmarked the button is "Check the rest and approve" (DC-136): a confirmation
// lists the files the daemon names and the POST sends that list back. A refusal shows the
// daemon's reason and the button goes back to what it was. Without an
// ApprovalPort (the standalone page, the HTML export) there is no button.

import { test, type Page } from '@playwright/test';
import { GUARD, MIGRATION } from '../../support/hud.js';
import { panelReport } from '../../support/panel.js';
import { card, cardButton, openReview, selectFile } from '../../support/review.js';
import { marksFromOverlay } from '../../support/review-api.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { test as standaloneTest } from '../../support/standalone.js';

test.describe.configure({ timeout: 90_000 });

const HEAD = '3f2a9c41d0b7e6a5c4d3e2f1a0b9c8d7e6f5a4b3';
/** Selects `file` and marks the whole file Checked from the selection card (a click lands on a floor). */
async function checkFile(page: Page, file: string): Promise<void> {
  await selectFile(page, file);
  await card(page).getByTestId('mark-scope-file').click();
  await cardButton(page, 'checked').click();
}

const bothTier1Checked = () => marksFromOverlay(panelReport(), { files: { [GUARD]: 'checked', [MIGRATION]: 'checked' } });

test('approve/gate/check-rest-until-tier1-marked', async ({ page }) => {
  const { api } = await openReview(page);
  const approve = page.getByTestId('approve');
  // Tier 1 files left unmarked: the button offers to check the rest, behind a confirmation (DC-136).
  await expect(approve).toHaveText('Check the rest and approve');
  await expect(approve).not.toHaveAttribute('aria-disabled');
  await expect(approve).toHaveAttribute('title', /^0 of 2 touched tier 1 files have a current review mark/);
  await expect(page.getByTestId('approve-control')).toHaveAttribute('data-bulk', 'true');

  // One tier 1 file checked: still the offer, the count moves with the daemon's progress.
  await checkFile(page, GUARD);
  await expect(approve).toHaveAttribute('title', /^1 of 2 touched tier 1 files have a current review mark/);
  await expect(approve).toHaveText('Check the rest and approve');

  // The other one: plain Approve, unchanged.
  await checkFile(page, MIGRATION);
  await expect(approve).toHaveText('Approve');
  await expect(approve).not.toHaveAttribute('aria-disabled');
  await expect(approve).toHaveAttribute('title', 'All 2 touched tier 1 files have a current review mark');
  await expect(page.getByTestId('approve-control')).toHaveAttribute('data-bulk', 'false');

  // Undo a mark: the offer again. Nothing was read or sent on the way.
  await cardButton(page, 'undo').click();
  await expect(approve).toHaveText('Check the rest and approve');
  expect(api.approval(11).writes).toEqual([]);
  expect(api.approval(11).remainingReads).toBe(0);
});

test('approve/gate/check-rest-and-approve-confirm-lists-files', async ({ page }) => {
  // The guard is checked; the migration is the one tier 1 file left.
  const { api } = await openReview(page, { marks: marksFromOverlay(panelReport(), { files: { [GUARD]: 'checked' } }) });
  const approve = page.getByTestId('approve');
  await expect(approve).toHaveText('Check the rest and approve');

  // A click asks the daemon for the list and shows it in a modal confirmation; nothing is written yet.
  await approve.click();
  const dialog = page.getByTestId('check-rest-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('heading')).toHaveText('Check the rest and approve');
  await expect(dialog.getByTestId('check-rest-file')).toHaveText([MIGRATION]);
  await expect(dialog.getByTestId('check-rest-lede')).toHaveText(
    '1 touched tier 1 file has no current mark. Confirming marks it Checked and approves the change at 3f2a9c4.',
  );
  await expect(dialog.getByTestId('check-rest-notice')).toBeHidden();
  const confirm = dialog.getByTestId('check-rest-confirm');
  await expect(confirm).toHaveText('Check 1 file and approve');
  await expect(confirm).toBeFocused();
  expect(api.approval(11).remainingReads).toBe(1);
  expect(api.approval(11).writes).toEqual([]);

  // Esc (and Cancel) leave everything as it was, focus back on the button.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(approve).toBeFocused();
  expect(api.approval(11).writes).toEqual([]);

  // Confirm: one POST carrying back exactly what the daemon listed; the file is marked, the change approved.
  await approve.click();
  await expect(dialog.getByTestId('check-rest-file')).toHaveText([MIGRATION]);
  await dialog.getByTestId('check-rest-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('approved-badge')).toHaveText('Approved 3f2a9c4');
  await expect(page.getByTestId('approve-undo')).toBeFocused();
  expect(api.approval(11).writes).toEqual(['POST']);
  const listed = api.approval(11).bodies[0] as { checkRemaining: boolean; snapshotId: number; files: string[]; token: string };
  expect(listed).toMatchObject({ checkRemaining: true, snapshotId: 1, files: [MIGRATION] });
  expect(listed.token).toMatch(/^[0-9a-f]{64}$/);
  expect(api.review(11).marks.find((mark) => mark.targetKind === 'file' && mark.filePath === MIGRATION)).toMatchObject({ mark: 'checked', state: 'current' });
  // The marks are read again: the progress says every tier 1 file is marked.
  await selectFile(page, MIGRATION);
  await card(page).getByTestId('mark-scope-file').click();
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
});

test('approve/gate/enabled-then-confirm-then-approved-badge', async ({ page }) => {
  const { api } = await openReview(page, { marks: bothTier1Checked() });
  const approve = page.getByTestId('approve');
  const reviewTag = page.getByTestId('change-head').locator('.tag.review');
  await expect(reviewTag).toHaveText('Unreviewed');
  await expect(approve).toHaveText('Approve');

  // Click: an inline confirm, not a dialog; Cancel goes back with the focus on Approve.
  await approve.click();
  const group = page.getByRole('group', { name: 'Confirm approve' });
  await expect(group).toContainText('Approve 3f2a9c4?');
  await expect(page.getByTestId('approve-confirm')).toBeFocused();
  await page.getByTestId('approve-cancel').click();
  await expect(group).toHaveCount(0);
  await expect(approve).toBeFocused();
  // Esc cancels too.
  await page.keyboard.press('Enter');
  await expect(group).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(group).toHaveCount(0);
  expect(api.approval(11).writes).toEqual([]);

  // Confirm: POST, then the badge with the short approved head, and the route's header follows.
  await approve.click();
  await page.getByTestId('approve-confirm').click();
  const badge = page.getByTestId('approved-badge');
  await expect(badge).toHaveText('Approved 3f2a9c4');
  await expect(badge).toHaveAttribute('title', new RegExp(`^Approved at ${HEAD}`));
  expect(api.approval(11).writes).toEqual(['POST']);
  await expect(page.getByTestId('approve-undo')).toBeFocused();
  await expect(reviewTag).toHaveText('Approved');
  await expect(approve).toHaveCount(0);

  // Undo: DELETE, back to Approve; the change is in review.
  await page.getByTestId('approve-undo').click();
  await expect(approve).toHaveText('Approve');
  await expect(badge).toHaveCount(0);
  await expect(reviewTag).toHaveText('In review');
  expect(api.approval(11).writes).toEqual(['POST', 'DELETE']);
});

test('approve/gate/server-refusal-shown', async ({ page }) => {
  const { api } = await openReview(page, { marks: bothTier1Checked() });
  const approve = page.getByTestId('approve');
  await expect(approve).toHaveText('Approve');
  // The daemon checks the gate itself: here a mark went stale between the progress and the click.
  const message = '1 touched tier 1 file(s) have no current review mark: <b>src/auth/order.guard.ts</b>';
  api.approval(11).failNext = { status: 409, code: 'tier1-unchecked', message };
  await approve.click();
  await page.getByTestId('approve-confirm').click();
  const error = page.getByTestId('approve-error');
  await expect(error).toHaveText(message);
  await expect(error).toHaveAttribute('role', 'alert');
  // Inert text: no element was made of it.
  await expect(error.locator('b')).toHaveCount(0);
  // Back to the button as it was, no badge.
  await expect(approve).toHaveText('Approve');
  await expect(approve).not.toHaveAttribute('aria-disabled');
  await expect(page.getByTestId('approved-badge')).toHaveCount(0);
  expect(api.approval(11).writes).toEqual(['POST']);

  // The next try clears the reason and goes through.
  await approve.click();
  await expect(error).toHaveCount(0);
  await page.getByTestId('approve-confirm').click();
  await expect(page.getByTestId('approved-badge')).toHaveText('Approved 3f2a9c4');
});

test('approve/gate/open-when-no-tier1-file-touched', async ({ page }) => {
  // A change that touches no tier 1 file: progress.tier1 is 0 of 0, nothing stands in the way.
  const report = panelReport();
  report.summary.tier1Files = [];
  for (const pkg of report.packages) pkg.tier1 = false;
  const { api } = await openReview(page, { report });
  const approve = page.getByTestId('approve');
  await expect(approve).toHaveText('Approve');
  await expect(approve).not.toHaveAttribute('aria-disabled');
  await expect(approve).toHaveAttribute('title', 'No tier 1 file is touched in this change');
  // Keyboard only: focus, Enter opens the confirm, Enter confirms.
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('approve-confirm')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('approved-badge')).toHaveText('Approved 3f2a9c4');
  expect(api.approval(11).writes).toEqual(['POST']);
});

standaloneTest('approve/gate/hidden-without-port',async ({ page, standalone }) => {
  await standalone.open(panelReport());
  await expect(page.getByTestId('hud-bar')).toBeVisible();
  await expect(page.getByTestId('export-plantuml')).toBeVisible();
  await expect(page.getByTestId('approve-control')).toHaveCount(0);
  await expect(page.getByTestId('approve')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /approve/i })).toHaveCount(0);
});
