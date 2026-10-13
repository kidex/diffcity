// Proof video for DC-136 (faster review, screen side; daemon side DC-135),
// against the real daemon from dist/, in a temporary home, on the invented
// order-discounts change. The claude it runs is a STUB in a temporary
// directory (agentLaunch.claudePath in the temporary settings.json); the real
// claude is never run. W marks Needs rewrite at once, without a note, and the
// summary asks to "Rewrite this file"; "Check the rest and approve" lists the
// touched tier 1 files without a mark and, once confirmed, marks them and
// approves; "Send to agent" in the top bar opens the send dialog directly, with
// the general note editable in it: a general note alone is sent, after the
// exact command and the summary read to its end. Recorded by
// `npm run proof -- DC-136`.

import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report } from '../../../src/core/report/types.js';
import { homePaths } from '../../../src/core/home.js';
import { readSettings, writeSettings } from '../../../src/core/settings/index.js';
import { getJson, GUARD, stubEnv, trackScenario } from '../support/change-daemon.js';
import { criterion, expect, HOLD_MS, test, titleCard } from '../support/proof.js';
import { card, cardButton, scrollSummaryToEnd, selectFile, sendDialog, summaryDialog } from '../support/review.js';
import { camera, waitReady } from '../support/scene.js';

/** The stub claude: shell builtins only, one absolute sleep, an answer like `claude -p --output-format json`. */
const STUB = [
  '#!/bin/sh',
  '# A stand-in for claude in the DC-136 proof: reads the summary, waits, answers.',
  'while IFS= read -r line || [ -n "$line" ]; do :; done',
  '/bin/sleep 4',
  'printf \'{"type":"result","subtype":"success","is_error":false,"result":"Split the discount rules out.","session_id":"7a1c2e3d-4b5f-4c6d-8e9f-0a1b2c3d4e5f"}\\n\'',
  '',
].join('\n');

const NOTE = 'Split the discount rules out of the order service, and keep them covered by a test.';

test('DC-136: rewrite without a note, check the rest and approve, send a general note from the top bar', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-136: faster review', [
    'The real daemon from dist/, in a temporary home, on the invented order-discounts change.',
    'claude is a stub script in a temporary directory: it reads the summary, waits 4 s and prints a JSON result.',
    'agentLaunch is enabled for this repo only, in the temporary settings.json. The real claude never runs.',
  ]);

  const bin = join(proof.root, 'stub-bin');
  await mkdir(bin);
  const claude = join(bin, 'claude');
  await writeFile(claude, STUB, 'utf8');
  await chmod(claude, 0o755);
  // macOS vets the first exec of a new file: pay it now, not during the run.
  await new Promise<void>((resolve) => {
    const child = execFile(claude, [], { timeout: 30_000 }, () => {
      resolve();
    });
    child.stdin?.end('warm-up\n');
  });

  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  const changeId = tracked.change.id;
  const settingsPath = homePaths(proof.home).settings;
  const read = await readSettings(settingsPath);
  if (!read.ok) throw new Error(read.error);
  await writeSettings(settingsPath, { ...read.settings, agentLaunch: { enabled: true, repos: [tracked.repo.dir], claudePath: claude } });
  const report = await getJson<Report>(`${proof.baseURL}/api/changes/${String(changeId)}/report`);
  const tier1 = report.summary.tier1Files;

  await page.goto(tracked.url);
  await waitReady(page);
  await expect
    .poll(
      async () => {
        const before = JSON.stringify(await camera(page));
        await page.waitForTimeout(400);
        return before === JSON.stringify(await camera(page));
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(page.getByTestId('progress')).toBeVisible();

  await criterion(
    page,
    '1. W marks Needs rewrite at once: no dialog, no note; the summary asks to rewrite the file',
    async () => {
      await selectFile(page, GUARD);
      await card(page).getByTestId('mark-scope-file').click();
      await page.keyboard.press('w');
      await expect(page.getByTestId('rewrite-dialog')).toHaveCount(0);
      await expect(card(page).getByTestId('mark-current')).toHaveText('Needs rewrite');
      await expect(page.getByTestId('progress-rewrite')).toHaveText('1 to rewrite');
      await expect(card(page).getByTestId('mark-note-edit')).toHaveText('Add note');
      await page.waitForTimeout(HOLD_MS / 2);
      await page.getByTestId('review-summary').click();
      await expect(summaryDialog(page).getByTestId('summary-text')).toContainText('Rewrite this file');
      await page.waitForTimeout(HOLD_MS);
      await page.keyboard.press('Escape');
      // Undo: the rest of the proof starts from a change with no mark.
      await cardButton(page, 'undo').click();
      await expect(card(page).getByTestId('mark-none')).toHaveText('Not marked');
      await page.keyboard.press('Escape');
    },
    'PUT /review/marks { mark: "rewrite" } with no note → 200; GET /review/summary → "- Rewrite this file"',
  );

  await criterion(
    page,
    '2. Check the rest and approve: one confirmation lists the tier 1 files, then they are marked and the change approved',
    async () => {
      const approve = page.getByTestId('approve');
      await expect(approve).toHaveText('Check the rest and approve');
      await approve.click();
      const dialog = page.getByTestId('check-rest-dialog');
      await expect(dialog.getByTestId('check-rest-file')).toHaveText(tier1);
      await page.waitForTimeout(HOLD_MS);
      await dialog.getByTestId('check-rest-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('approved-badge')).toBeVisible();
      await expect(page.getByTestId('progress-attention')).toBeVisible();
      await page.waitForTimeout(HOLD_MS / 2);
    },
    `GET /approve/remaining → ${String(tier1.length)} file(s) and a token; POST /approve { checkRemaining: true, snapshotId, files, token } → approved`,
  );

  await criterion(
    page,
    '3. Send to agent from the top bar: nothing to send yet; a general note, saved in the dialog, is previewed again',
    async () => {
      await page.getByTestId('send-to-agent').click();
      const dialog = sendDialog(page);
      await expect(dialog).toBeVisible();
      await expect(summaryDialog(page)).toHaveCount(0);
      await expect(dialog.getByTestId('send-loading')).toHaveCount(0);
      await expect(dialog.getByTestId('send-refusal').first()).toHaveAttribute('data-code', 'nothing-to-send');
      await expect(dialog.getByTestId('send-run')).toBeHidden();
      await page.waitForTimeout(HOLD_MS / 2);
      await dialog.getByTestId('send-note').fill(NOTE);
      await expect(dialog.getByTestId('send-hint')).toBeVisible();
      await dialog.getByTestId('send-note-save').click();
      await expect(dialog.getByTestId('send-note-status')).toHaveText('Note saved; the summary below now holds it');
      await expect(dialog.getByTestId('send-summary')).toContainText(NOTE);
      await expect(dialog.getByTestId('send-refusals')).toBeHidden();
      await expect(dialog.getByTestId('send-argv').locator('li').first()).toHaveText(claude);
    },
    'PUT /review/note, then POST /agent/preview: the summary, its hash and the token now hold the note',
  );

  await criterion(
    page,
    '4. Read to its end, sent: the agent works on the general note alone',
    async () => {
      const dialog = sendDialog(page);
      await scrollSummaryToEnd(page, dialog);
      const send = dialog.getByTestId('send-run');
      await expect(send).toBeEnabled();
      await page.waitForTimeout(HOLD_MS / 2);
      await send.click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('send-to-agent')).toBeFocused();
      await expect(page.getByTestId('agent-run')).toHaveAttribute('data-state', 'running');
      await expect(page.getByTestId('agent-run-text')).toHaveText('Agent is working on 1 note');
      await expect(page.getByTestId('agent-run')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
      await expect(page.getByTestId('agent-run-exit')).toHaveText('exit 0');
    },
    'POST /agent/run with the token and summary hash of the preview just shown → 202; the stub ends with exit 0',
  );
});
