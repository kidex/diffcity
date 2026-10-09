// Proof video for DC-134 (phase 4 T19): "Send review to agent" in the change
// screen, against the real daemon from dist/, in a temporary home, on the
// invented order-discounts change. The claude it runs is a STUB in a temporary
// directory (agentLaunch.claudePath in the temporary settings.json): it reads
// the summary on stdin, waits a few seconds and prints a JSON result. The real
// claude is never run. The dialog shows the exact argv, the working tree, why
// a new session, the permission note and the full summary; Send is enabled
// only once the summary was scrolled to its end; the top bar says the agent is
// working, then the end state, exit code and log name, also after a reload. A
// refused launch lists its reason and the fix queue still takes the summary.
// Recorded by `npm run proof -- DC-134`.

import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunsResponse } from '../../../src/core/model/types.js';
import { homePaths } from '../../../src/core/home.js';
import { readSettings, writeSettings } from '../../../src/core/settings/index.js';
import { GUARD, stubEnv, trackScenario, until } from '../support/change-daemon.js';
import { criterion, expect, HOLD_MS, test, titleCard } from '../support/proof.js';
import { markInPage, openSendDialog, scrollSummaryToEnd, sendDialog, summaryDialog } from '../support/review.js';
import { camera, waitReady } from '../support/scene.js';

/** How long the stub "works" before it answers. */
const STUB_SECONDS = 6;

/** The stub claude: shell builtins only (the runner passes an allow-listed environment), one absolute sleep. */
const STUB = [
  '#!/bin/sh',
  '# A stand-in for claude in the DC-134 proof: reads the summary, waits, answers like `claude -p --output-format json`.',
  'lines=0',
  'while IFS= read -r line || [ -n "$line" ]; do lines=$((lines + 1)); done',
  'printf "stub claude: read %s summary lines on stdin\\n" "$lines" >&2',
  `/bin/sleep ${String(STUB_SECONDS)}`,
  'printf \'{"type":"result","subtype":"success","is_error":false,"result":"Rewrote the guard as the review asked.","session_id":"5d1c7a2e-8f3b-4e6a-9c0d-2b7e4f1a3c5d"}\\n\'',
  '',
].join('\n');

async function writeAgentLaunch(settingsPath: string, agentLaunch: Record<string, unknown>): Promise<void> {
  const read = await readSettings(settingsPath);
  if (!read.ok) throw new Error(read.error);
  await writeSettings(settingsPath, { ...read.settings, agentLaunch });
}

test('DC-134: Send review to agent, with the exact command, confirmation and run status', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-134: Send review to agent', [
    'The real daemon from dist/, in a temporary home, on the invented order-discounts change.',
    'claude is a stub script in a temporary directory: it reads the summary, waits 6 s and prints a JSON result.',
    'agentLaunch is enabled for this repo only, in the temporary settings.json. The real claude never runs.',
  ]);

  const bin = join(proof.root, 'stub-bin');
  await mkdir(bin);
  const claude = join(bin, 'claude');
  await writeFile(claude, STUB, 'utf8');
  await chmod(claude, 0o755);
  // macOS vets the first exec of a new file (syspolicyd): pay it now, not during the run.
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
  await writeAgentLaunch(settingsPath, { enabled: true, repos: [tracked.repo.dir], claudePath: claude });

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
  // One "Needs rewrite" mark and a general note, written from the page as the screen writes them.
  await markInPage(page, changeId, { kind: 'file', id: GUARD }, 'rewrite', 'Check the owner before the discount, not after.');
  // A general note long enough that the summary does not fit in the dialog: Send waits for its end.
  const note = Array.from({ length: 32 }, (_, i) => `- Checklist item ${String(i + 1)}: keep the discount rules covered by a test.`).join('\n');
  await page.evaluate(`fetch('/api/changes/${String(changeId)}/review/note', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: ${JSON.stringify(note)} }) }).then((r) => { if (!r.ok) throw new Error('note refused: ' + r.status); })`);
  await expect(page.getByTestId('progress')).toBeVisible();

  let dialog = sendDialog(page);
  await criterion(
    page,
    '1. Review summary → Send review to agent: the exact command, the working tree, the session, the permissions',
    async () => {
      dialog = await openSendDialog(page);
      const argv = dialog.getByTestId('send-argv').locator('li');
      await expect(argv.first()).toHaveText(claude);
      await expect(argv).toContainText(['-p']);
      // The daemon shows the working tree's realpath (/tmp is /private/tmp on macOS).
      await expect(dialog.getByTestId('send-cwd')).toHaveText(await realpath(tracked.repo.dir));
      await expect(dialog.getByTestId('send-session')).toHaveText('New session: No Claude Code session of this working tree is linked to the change');
      await expect(dialog.getByTestId('send-permission')).toHaveText('The agent runs with your Claude Code permission settings for this project');
      await expect(dialog.getByTestId('send-summary')).toContainText('Check the owner before the discount, not after.');
      await dialog.getByTestId('send-argv').hover();
    },
    'POST /api/changes/:id/agent/preview: argv one item per line, the stub claude first',
  );

  await criterion(
    page,
    '2. Send stays disabled until the whole summary has been scrolled into view',
    async () => {
      const send = dialog.getByTestId('send-run');
      await expect(send).toBeDisabled();
      await expect(dialog.getByTestId('send-hint')).toHaveText('Read the summary to its end to send it');
      await page.waitForTimeout(HOLD_MS / 2);
      await scrollSummaryToEnd(page, dialog);
      await expect(send).toBeEnabled();
      await expect(send).toBeFocused();
    },
    'an IntersectionObserver on the end of the summary; then Send is enabled and focused',
  );

  const status = page.getByTestId('agent-run');
  let log = '';
  await criterion(
    page,
    '3. Send to agent: the top bar says the agent is working on the notes',
    async () => {
      await dialog.getByTestId('send-run').click();
      await expect(summaryDialog(page)).toBeHidden();
      await expect(status).toHaveAttribute('data-state', 'running');
      await expect(page.getByTestId('agent-run-text')).toHaveText('Agent is working on 2 notes');
      log = (await page.getByTestId('agent-run-log').textContent()) ?? '';
      expect(log).toMatch(new RegExp(`^${String(changeId)}-[0-9a-f]{16}\\.log$`));
      const runs = await page.evaluate<AgentRunsResponse>(`fetch('/api/changes/${String(changeId)}/agent/runs').then((r) => r.json())`);
      expect(runs.running).toBe(true);
    },
    'POST /agent/run → 202 { runId }; SSE agent-run running; GET /agent/runs → running: true',
  );

  await criterion(
    page,
    '4. The stub answers: done, exit 0, and the run log’s file name',
    async () => {
      await expect(status).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
      await expect(page.getByTestId('agent-run-text')).toHaveText('Agent finished');
      await expect(page.getByTestId('agent-run-exit')).toHaveText('exit 0');
      await expect(page.getByTestId('agent-run-log')).toHaveText(log);
      expect(await readdir(homePaths(proof.home).runs)).toContain(log);
    },
    `SSE agent-run done; the log is <temporary home>/runs/${log || '<change>-<run>.log'}`,
  );

  await criterion(
    page,
    '5. A reload reads the run back from the daemon',
    async () => {
      await page.reload();
      await waitReady(page);
      await expect(page.getByTestId('agent-run-text')).toHaveText('Agent finished');
      await expect(page.getByTestId('agent-run-exit')).toHaveText('exit 0');
      await expect(page.getByTestId('agent-run-log')).toHaveText(log);
    },
    'GET /api/changes/:id/agent/runs → the latest run',
  );

  await criterion(
    page,
    '6. Launch turned off: the reason is listed, no Send; Add to fix queue still works',
    async () => {
      await writeAgentLaunch(settingsPath, { enabled: false, repos: [tracked.repo.dir], claudePath: claude });
      dialog = await openSendDialog(page);
      await expect(dialog.getByTestId('send-refusal')).toHaveText(['agent launch is off (agentLaunch.enabled in settings.json)']);
      await expect(dialog.getByTestId('send-run')).toBeHidden();
      await page.waitForTimeout(HOLD_MS / 2);
      await dialog.getByTestId('send-queue').click();
      await expect(dialog.getByTestId('send-status')).toHaveText('Added to the fix queue (1 item waiting for /diffcity-review)');
      const queued = await until(async () => {
        const names = await readdir(join(tracked.repo.dir, '.diffcity', 'fix-queue')).catch(() => []);
        return names.length > 0 ? names : undefined;
      }, 10_000, 'the summary in the fix queue');
      expect(queued).toHaveLength(1);
    },
    'POST /review/summary/queue → .diffcity/fix-queue/<id>.json in the working tree; nothing runs',
  );
});
