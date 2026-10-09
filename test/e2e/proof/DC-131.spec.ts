// Proof video for DC-131 (phase 4 T17): the Session tab of the change screen
// against the real daemon from dist/, in a temporary home, with an invented
// Claude Code transcript under a temporary CLAUDE_CONFIG_DIR. The built CLI
// runs as the Stop hook (`diffcity track --agent` with the hook JSON on
// stdin), the daemon links the session to the order-discounts change and
// reads it, and the panel shows the Session tab: prompts, the question and its
// answer, the agents that ran with their reports, the edited files that
// select their building. Another Stop with more transcript updates the tab
// live (SSE `sessions`); a transcript swapped for a symbolic link makes the
// session unreadable.
// Recorded by `npm run proof -- DC-131`.

import { spawn } from 'node:child_process';
import { appendFile, mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionsResponse } from '../../../src/core/model/types.js';
import { subagentsDir } from '../../../src/core/session/index.js';
import { CLI_DIST } from '../../helpers/daemon.js';
import { agentMeta, transcript } from '../../helpers/transcript.js';
import { getJson, GUARD, SERVICE, stubEnv, trackScenario, until } from '../support/change-daemon.js';
import { criterion, expect, test, titleCard } from '../support/proof.js';
import { waitForCityAttribute, waitReady } from '../support/scene.js';

const SESSION = '7c1e2d3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const QUESTION = { question: 'Round discounted totals per line or per order?', header: 'Rounding', options: ['Per line', 'Per order'] };

/** The built CLI as Claude Code's Stop hook: the hook JSON on stdin, in the repo. */
function stopHook(dir: string, transcriptPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, 'track', '--agent'], { cwd: dir, env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`track --agent exited with ${String(code)}`));
    });
    child.stdin.end(JSON.stringify({ session_id: SESSION, transcript_path: transcriptPath, cwd: dir, hook_event_name: 'Stop' }));
  });
}

test('DC-131: the Session tab shows the Claude Code sessions linked to a change', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-131: the Session tab (ADR-038)', [
    'The real daemon from dist/, in a temporary home, on the golden order-discounts repo.',
    'An invented Claude Code transcript under a temporary CLAUDE_CONFIG_DIR.',
    'The built CLI runs as the Stop hook: diffcity track --agent, hook JSON on stdin.',
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

  // The transcript: a prompt, a question and its answer, the main agent's read and edit, a foreground Plan run and a background implementer with its own edits.
  const start = new Date(Date.now() - 60 * 60_000).toISOString();
  const main = transcript({ sessionId: SESSION, cwd: dir, branch: 'feature/order-discounts', start });
  main.prompt('Add percentage discounts to orders. Keep the owner check in the guard.');
  const ask = main.ask([QUESTION]);
  main.answer(ask, [QUESTION], { [QUESTION.question]: 'Per order' });
  main.toolResult(main.toolCall('Read', { file_path: join(dir, SERVICE) }), {}, 'file contents');
  main.toolResult(main.toolCall('Edit', { file_path: join(dir, GUARD), old_string: 'a', new_string: 'b' }), {}, 'ok');
  main.agent({ agentId: 'plan01', type: 'Plan', description: 'Plan the discount rules', foreground: { report: 'Three steps: rules module, service change, migration.', durationMs: 95_000, toolUses: 6 } });
  main.agent({ agentId: 'impl01', type: 'general-purpose', description: 'Implement the discount service' });
  main.wait(300_000).notification({ agentId: 'impl01', status: 'completed', durationMs: 312_000, toolUses: 9, result: 'Added applyDiscount to OrdersService. Tests pass.' });
  main.handback('impl01', 'Added applyDiscount to OrdersService and the rules module. Tests pass.');
  main.aiTitle('Add percentage discounts to orders');
  const path = join(project, `${SESSION}.jsonl`);
  await writeFile(path, main.jsonl());
  const side = transcript({ sessionId: SESSION, cwd: dir, agentId: 'impl01', start });
  side.toolResult(side.toolCall('Edit', { file_path: join(dir, SERVICE), old_string: 'a', new_string: 'b' }), {}, 'ok');
  side.toolResult(side.toolCall('Bash', { command: 'npm test' }), {}, 'ok');
  await mkdir(subagentsDir(path), { recursive: true });
  await writeFile(join(subagentsDir(path), 'agent-impl01.jsonl'), side.jsonl());
  await writeFile(join(subagentsDir(path), 'agent-impl01.meta.json'), JSON.stringify(agentMeta({ agentType: 'general-purpose', description: 'Implement the discount service' })));

  await stopHook(dir, path, env);
  await until(async () => ((await getJson<SessionsResponse>(sessionsUrl)).sessions[0]?.digest ?? undefined), 60_000, 'the session read');

  const card = page.getByTestId('session-card').first();
  await criterion(page, '1. The Session tab: one card per session, with prompts, the question and its answer', async () => {
    await page.goto(tracked.url);
    await waitReady(page);
    await expect(page.getByTestId('tab-session')).toBeVisible();
    await page.getByTestId('tab-session').click();
    await expect(card.getByTestId('session-title')).toHaveText('Add percentage discounts to orders');
    await expect(card.getByTestId('session-here')).toBeVisible();
    await expect(card.getByTestId('session-prompt')).toHaveText(['Add percentage discounts to orders. Keep the owner check in the guard.']);
    await expect(card.getByTestId('question-answer')).toHaveText(['Per order']);
  }, 'GET /api/changes/:id/sessions, read by the daemon after the Stop hook');

  await criterion(page, '2. The agents that ran: type, description, duration, status, here; Enter shows the report and activity', async () => {
    await expect(card.getByTestId('run-type')).toHaveText(['Plan', 'general-purpose']);
    await expect(card.getByTestId('run-status')).toHaveText(['completed', 'completed']);
    const impl = card.getByTestId('session-run').nth(1);
    await impl.getByTestId('run-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(impl.getByTestId('run-report')).toContainText('Added applyDiscount to OrdersService');
    await expect(impl.getByTestId('edited-file')).toHaveText([SERVICE]);
  }, 'the implementer worked in this change’s working tree: here');

  await criterion(page, '3. An edited file selects its building', async () => {
    await card.getByTestId('session-wide').locator(`[data-testid="edited-file"][data-path="${GUARD}"]`).click();
    await waitForCityAttribute(page, 'data-selected', GUARD);
  }, GUARD);

  await criterion(page, '4. Another Stop with a new prompt: the tab updates live (SSE sessions)', async () => {
    const more = transcript({ sessionId: SESSION, cwd: dir, branch: 'feature/order-discounts', start: new Date().toISOString() });
    more.prompt('Also cover the cancel endpoint.');
    await appendFile(path, more.jsonl());
    await stopHook(dir, path, env);
    await expect(card.getByTestId('session-prompt')).toHaveCount(2, { timeout: 60_000 });
  }, 'no reload');

  await criterion(page, '5. A transcript swapped for a symbolic link: "Session data could not be read"', async () => {
    const outside = join(proof.root, 'outside');
    await mkdir(outside, { recursive: true });
    await rename(path, join(outside, `${SESSION}.jsonl`));
    await symlink(join(outside, `${SESSION}.jsonl`), path);
    await stopHook(dir, path, env);
    await expect(card.getByTestId('session-unreadable')).toHaveText('Session data could not be read', { timeout: 60_000 });
    await expect(card.getByTestId('session-prompt')).toHaveCount(0);
  }, 'refused on validation: no content shown');
});
