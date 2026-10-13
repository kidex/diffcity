// Proof video for DC-138 (phase 4): the Session tab's "active" tag against the
// real daemon from dist/, in a temporary home, with an invented Claude Code
// transcript under a temporary CLAUDE_CONFIG_DIR. The built CLI runs as the
// Stop hook: the card shows "active" beside "here", and a background agent
// with no outcome yet is running. The built CLI then runs as the SessionEnd
// hook (DC-128): the tag goes live (SSE `sessions`) and the run with no
// outcome reads unknown.
// Recorded by `npm run proof -- DC-138`.

import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionsResponse } from '../../../src/core/model/types.js';
import { CLI_DIST } from '../../helpers/daemon.js';
import { transcript } from '../../helpers/transcript.js';
import { getJson, GUARD, stubEnv, trackScenario, until } from '../support/change-daemon.js';
import { criterion, expect, test, titleCard } from '../support/proof.js';
import { waitReady } from '../support/scene.js';

const SESSION = '3b8d1f2e-6c4a-4e9b-a1d2-5f6e7a8b9c0d';

/** The built CLI as one of Claude Code's hooks: the hook JSON on stdin, in the repo. */
function hook(event: 'Stop' | 'SessionEnd', dir: string, transcriptPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const input = { session_id: SESSION, transcript_path: transcriptPath, cwd: dir, hook_event_name: event, ...(event === 'SessionEnd' ? { reason: 'prompt_input_exit' } : {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, 'track', '--agent'], { cwd: dir, env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`track --agent (${event}) exited with ${String(code)}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('DC-138: the Session tab marks a session active until it ends', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-138: the "active" tag in the Session tab', [
    'The real daemon from dist/, in a temporary home, on the golden order-discounts repo.',
    'An invented Claude Code transcript under a temporary CLAUDE_CONFIG_DIR.',
    'The built CLI runs as the Stop hook, then as the SessionEnd hook.',
  ]);

  const claude = join(proof.root, 'claude');
  const project = join(claude, 'projects', '-work-order-shop');
  await mkdir(project, { recursive: true });
  const env = { ...(await stubEnv(proof)), CLAUDE_CONFIG_DIR: claude };
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  // Claude Code records real paths: on macOS the temporary directory is under /private.
  const dir = await realpath(tracked.repo.dir);
  const sessionsUrl = `${proof.baseURL}/api/changes/${String(tracked.change.id)}/sessions`;

  // A prompt, an edit by the main agent and a background agent that has not reported back.
  const main = transcript({ sessionId: SESSION, cwd: dir, branch: 'feature/order-discounts', start: new Date(Date.now() - 30 * 60_000).toISOString() });
  main.prompt('Keep the owner check in the order guard.');
  main.toolResult(main.toolCall('Edit', { file_path: join(dir, GUARD), old_string: 'a', new_string: 'b' }), {}, 'ok');
  main.agent({ agentId: 'rev01', type: 'general-purpose', description: 'Review the guard change' });
  main.aiTitle('Owner check in the order guard');
  const path = join(project, `${SESSION}.jsonl`);
  await writeFile(path, main.jsonl());

  await hook('Stop', dir, path, env);
  await until(async () => ((await getJson<SessionsResponse>(sessionsUrl)).sessions[0]?.digest ?? undefined), 60_000, 'the session read');

  const card = page.getByTestId('session-card').first();
  await criterion(page, '1. After the Stop hook the session is active: the card shows "active" beside "here"', async () => {
    await page.goto(tracked.url);
    await waitReady(page);
    await page.getByTestId('tab-session').click();
    await expect(card.getByTestId('session-title')).toHaveText('Owner check in the order guard');
    await expect(card.getByTestId('session-here')).toBeVisible();
    await expect(card.getByTestId('session-active')).toHaveText('active');
    await expect(card.getByTestId('run-status')).toHaveText(['running']);
  }, 'GET /api/changes/:id/sessions: active true');

  await criterion(page, '2. The SessionEnd hook: the tag goes without a reload; the run with no outcome reads unknown', async () => {
    await hook('SessionEnd', dir, path, env);
    await expect(card.getByTestId('session-active')).toHaveCount(0, { timeout: 60_000 });
    await expect(card.getByTestId('run-status')).toHaveText(['unknown'], { timeout: 60_000 });
    await expect(card.getByTestId('session-here')).toBeVisible();
  }, 'SSE sessions: active false');
});
