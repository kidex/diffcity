// e2e/session (SPEC.md sections 3, 6 and 7.2, ADR-038, phase 4 exit
// criterion): Claude Code session context against the real daemon from
// dist/, in a temporary DIFFCITY_HOME and CLAUDE_CONFIG_DIR, on the invented
// ledger repo with invented transcripts. The built `setup-claude` writes the
// Stop and SessionEnd hooks; the spec runs those very commands through a shell
// with Claude Code's hook JSON on stdin, as Claude Code does.
//
// - stop-hook-shows-session-and-agents: after Stop, the Session tab shows the
//   session with its prompt, question and answer, both agents and the edited
//   file, tagged "active"; after SessionEnd the tag goes live and the
//   background agent with no outcome reads unknown (DC-138);
// - secrets-redacted-in-ui: tokens in the transcript never reach the page,
//   the sessions route or the daemon's home, only `[redacted:<kind>]`;
// - report-and-diff-json-have-no-session-data: the served Report and
//   `diff --json` carry nothing of the session; `--with-sessions` does.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { ChangeSummary, RepoDetail, SessionsResponse } from '../../../src/core/model/types.js';
import type { TempRepo } from '../../helpers/repo.js';
import { transcript, type TranscriptBuilder } from '../../helpers/transcript.js';
import { getJson, until } from '../support/change-daemon.js';
import { expect, test, type ProofWorld } from '../support/proof.js';
import {
  buildLedger,
  cliRun,
  collected,
  JOURNAL,
  LEDGER_BRANCH,
  loopEnv,
  realDir,
  runHook,
  setupClaude,
  type ClaudeSetup,
  type Collected,
  type LoopEnv,
} from '../support/review-loop.js';
import { waitReady } from '../support/scene.js';

const SESSION = '5c2e8a41-7b3d-4f6a-9e1c-2d4b6f8a0c3e';
const TITLE = 'Double entry in the journal';
const PROMPT = 'Post both sides of every journal entry.';
const QUESTION = { question: 'Should a reversal post a new entry?', header: 'Reversal', options: ['Yes, a new entry', 'No, edit in place'] };
/** Every key a Report may have. */
const REPORT_KEYS = ['checks', 'findings', 'meta', 'packages', 'specNotice', 'steps', 'summary'];

interface World {
  loop: LoopEnv;
  setup: ClaudeSetup;
  repo: TempRepo;
  /** The working tree's real path, as Claude Code records it. */
  dir: string;
  transcriptPath: string;
}

/** The daemon, setup-claude, the ledger repo and the transcript directory; nothing tracked yet. */
async function start(proof: ProofWorld): Promise<World> {
  const loop = await loopEnv(proof);
  await proof.startDaemon(loop.env);
  const setup = await setupClaude(loop, proof.root);
  const repo = await buildLedger();
  proof.onTeardown(() => repo.cleanup());
  const dir = await realDir(repo);
  const project = join(loop.claude, 'projects', '-work-ledger');
  await mkdir(project, { recursive: true });
  return { loop, setup, repo, dir, transcriptPath: join(project, `${SESSION}.jsonl`) };
}

/** A main transcript in the ledger's working tree: a prompt, a question, an edit, a foreground and a background agent. */
function mainTranscript(world: World, prompt = PROMPT, report = 'Two callers post single entries: the import and the refund.'): TranscriptBuilder {
  const main = transcript({ sessionId: SESSION, cwd: world.dir, branch: LEDGER_BRANCH, start: new Date(Date.now() - 20 * 60_000).toISOString() });
  main.prompt(prompt);
  const ask = main.ask([QUESTION]);
  main.answer(ask, [QUESTION], { [QUESTION.question]: 'Yes, a new entry' });
  main.toolResult(main.toolCall('Edit', { file_path: join(world.dir, JOURNAL), old_string: '[amount]', new_string: '[amount, -amount]' }), {}, 'ok');
  main.agent({ agentId: 'exp01', type: 'Explore', description: 'Find the journal callers', foreground: { report, durationMs: 42_000, toolUses: 5 } });
  main.agent({ agentId: 'rev01', type: 'general-purpose', description: 'Review the double entry' });
  main.aiTitle(TITLE);
  return main;
}

/** Writes the transcript, runs the Stop hook from settings.json and waits until the session is read. */
async function stop(proof: ProofWorld, world: World, main: TranscriptBuilder): Promise<{ change: Collected; sessionsUrl: string }> {
  await writeFile(world.transcriptPath, main.jsonl());
  const hook = await runHook(world.setup.stop, 'Stop', { sessionId: SESSION, transcriptPath: world.transcriptPath, cwd: world.dir }, world.loop.env);
  expect(hook.code, hook.stderr).toBe(0);
  const change = await collected(proof, 'ledger', LEDGER_BRANCH);
  const sessionsUrl = `${proof.baseURL}/api/changes/${String(change.changeId)}/sessions`;
  await until(async () => (await getJson<SessionsResponse>(sessionsUrl)).sessions[0]?.digest ?? undefined, 60_000, 'the session read');
  return { change, sessionsUrl };
}

async function openSessionTab(page: Page, change: Collected): Promise<void> {
  await page.goto(change.url);
  await waitReady(page);
  await page.getByTestId('tab-session').click();
}

/** Every file under `dir`, as text. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return Promise.all(files.map((file) => readFile(file, 'latin1')));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
});

test('session/stop-hook-shows-session-and-agents', async ({ proof, page }) => {
  test.setTimeout(180_000);
  const world = await start(proof);
  const { change, sessionsUrl } = await stop(proof, world, mainTranscript(world));

  // Stop is a finished task: the hook registered the repo, collected the change and marked it.
  const summary = await getJson<RepoDetail>(`${proof.baseURL}/api/repos/${String(change.repoId)}`);
  const row = summary.changes.find((one) => one.id === change.changeId) as ChangeSummary;
  expect(row.agentUnreviewed).toBe(true);

  await openSessionTab(page, change);
  const card = page.getByTestId('session-card');
  await expect(card).toHaveCount(1);
  await expect(page.getByTestId('tab-session')).toContainText('Session');
  await expect(card.getByTestId('session-title')).toHaveText(TITLE);
  await expect(card.getByTestId('session-here')).toBeVisible();
  await expect(card.getByTestId('session-active')).toHaveText('active');
  await expect(card.getByTestId('session-range')).toBeVisible();
  await expect(card.getByTestId('session-prompt')).toHaveText([PROMPT]);
  await expect(card.getByTestId('question-text')).toHaveText([QUESTION.question]);
  await expect(card.getByTestId('question-answer')).toContainText(['Yes, a new entry']);
  // Both agents, in launch order: the foreground one finished with its report, the background one still runs.
  await expect(card.getByTestId('run-type')).toHaveText(['Explore', 'general-purpose']);
  await expect(card.getByTestId('run-description')).toHaveText(['Find the journal callers', 'Review the double entry']);
  await expect(card.getByTestId('run-status')).toHaveText(['completed', 'running']);
  await expect(card.getByTestId('run-duration').first()).toHaveText('42 s');
  await card.getByTestId('run-toggle').first().click();
  await expect(card.getByTestId('run-report').first()).toContainText('Two callers post single entries');
  // The edited file is a building of the change: a click selects it.
  const edited = card.locator(`[data-testid="edited-file"][data-path="${JOURNAL}"]`).first();
  await expect(edited).toBeVisible();
  await edited.click();
  await expect(page.getByTestId('city')).toHaveAttribute('data-selected', JOURNAL, { timeout: 30_000 });
  await page.keyboard.press('Escape');

  // SessionEnd, through the command setup-claude wrote: the tag goes without a reload, the run with no outcome reads unknown.
  const end = await runHook(world.setup.sessionEnd, 'SessionEnd', { sessionId: SESSION, transcriptPath: world.transcriptPath, cwd: world.dir }, world.loop.env);
  expect(end.code, end.stderr).toBe(0);
  await expect(card.getByTestId('session-active')).toHaveCount(0, { timeout: 60_000 });
  await expect(card.getByTestId('run-status')).toHaveText(['completed', 'unknown'], { timeout: 60_000 });
  await expect(card.getByTestId('session-here')).toBeVisible();
  expect((await getJson<SessionsResponse>(sessionsUrl)).sessions[0]?.active).toBe(false);
});

test('session/secrets-redacted-in-ui', async ({ proof, page }) => {
  test.setTimeout(180_000);
  const world = await start(proof);
  // Invented credentials, put together at run time so no secret scanner sees them in the source.
  const github = ['gh', 'p_', 'Q7wE5rT3yU1iO9pA8sD6fG4hJ2kL0zX3cV5b'].join('');
  const aws = ['AK', 'IA', 'Z3X9Q2W8E7R6T5Y4'].join('');
  const apiKey = ['sk', '-', 'ant-', 'm4Nq8Rt2Vx6Zb0Kd3Hf7Jw'].join('');
  const password = ['hunter', '2', '-ledger-', '91'].join('');
  const prompt = `Use ${github} to push and ${aws} for the bucket.`;
  const report = `Found DB_PASSWORD=${password} and the key ${apiKey} in the config.`;
  const { change, sessionsUrl } = await stop(proof, world, mainTranscript(world, prompt, report));

  await openSessionTab(page, change);
  const card = page.getByTestId('session-card');
  await expect(card.getByTestId('session-prompt')).toHaveText(['Use [redacted:github-token] to push and [redacted:aws-key] for the bucket.']);
  await card.getByTestId('run-toggle').first().click();
  await expect(card.getByTestId('run-report').first()).toContainText('[redacted:api-key]');
  await expect(card.getByTestId('run-report').first()).not.toContainText(password);

  const pageText = (await page.locator('body').textContent()) ?? '';
  const served = JSON.stringify(await getJson<SessionsResponse>(sessionsUrl));
  const stored = await filesUnder(proof.home);
  for (const secret of [github, aws, apiKey, password]) {
    expect(pageText).not.toContain(secret);
    expect(served).not.toContain(secret);
    for (const text of stored) expect(text.includes(secret), 'a raw secret in the daemon home').toBe(false);
  }
  expect(served).toContain('[redacted:github-token]');
});

test('session/report-and-diff-json-have-no-session-data', async ({ proof }) => {
  test.setTimeout(180_000);
  const world = await start(proof);
  const { change } = await stop(proof, world, mainTranscript(world));
  const traces = [SESSION, TITLE, PROMPT, QUESTION.question, 'Find the journal callers', 'Review the double entry', 'exp01', 'rev01'];

  const reportText = await (await fetch(change.reportUrl)).text();
  const report = JSON.parse(reportText) as Record<string, unknown>;
  for (const key of Object.keys(report)) expect(REPORT_KEYS).toContain(key);
  for (const trace of traces) expect(reportText).not.toContain(trace);

  for (const args of [['diff', '--json'], ['diff', '--json', '--compact']]) {
    const run = await cliRun(args, world.dir, world.loop.env);
    expect(run.code, run.stderr).toBe(0);
    const diff = JSON.parse(run.stdout) as Record<string, unknown>;
    for (const key of Object.keys(diff)) expect(REPORT_KEYS).toContain(key);
    for (const trace of traces) expect(run.stdout).not.toContain(trace);
  }

  // Only the explicit flag adds them, next to the Report's own keys.
  const withSessions = await cliRun(['diff', '--json', '--with-sessions'], world.dir, world.loop.env);
  expect(withSessions.code, withSessions.stderr).toBe(0);
  const parsed = JSON.parse(withSessions.stdout) as { sessions?: { sessionId: string; title: string | null }[] };
  expect(parsed.sessions?.map((one) => [one.sessionId, one.title])).toEqual([[SESSION, TITLE]]);
});
