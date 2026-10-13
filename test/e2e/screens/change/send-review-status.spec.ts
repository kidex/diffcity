// e2e/change/send-review-status (ADR-029, DC-134): the agent run status in the
// top bar: "Agent is working on N notes" while the daemon says a run is in
// progress; at the end its state, exit code and the run log's file name, moved
// on by SSE `agent-run`; read again from GET runs after a reload. The fallback
// "Add to fix queue" works whatever the preview refused. Without an AgentPort
// (the standalone page, the export) none of it exists.

import { test } from '@playwright/test';
import type { AgentRunView } from '../../../../src/core/model/types.js';
import { agentPreview } from '../../support/mock-api.js';
import { panelReport, PLACE, APPLY } from '../../support/panel.js';
import { agentRun, openReview, openSendDialog, scrollSummaryToEnd, summaryDialog } from '../../support/review.js';
import { seedMark } from '../../support/review-api.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';
import { test as standaloneTest } from '../../support/standalone.js';

test.describe.configure({ timeout: 90_000 });

const report = panelReport();
// Two "Needs rewrite" marks and a general note: three notes.
const marks = [seedMark(report, 'symbol', PLACE, 'rewrite'), seedMark(report, 'symbol', APPLY, 'rewrite')];
const NOTE = 'Ship after the rewrites.';

const running = (): AgentRunView => ({
  runId: '0123456789abcdef',
  state: 'running',
  mode: 'resume',
  startedAt: '2026-05-02T11:10:00.000Z',
  durationMs: null,
  exitCode: null,
  log: '11-0123456789abcdef.log',
  message: null,
});

test('change/send-review-status: run-status-and-log-link', async ({ page }, testInfo) => {
  await tagClient(page, testInfo.testId);
  const { api } = await openReview(page, { report, marks, note: NOTE, wait: false });
  const mock = api.agent(11);
  // Never ran: no status at all.
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  await expect(page.getByTestId('progress')).toBeVisible();
  await expect.poll(() => api.count('/api/changes/11/agent/runs')).toBeGreaterThan(0);
  await expect(agentRun(page)).toBeHidden();

  // The daemon starts a run (SSE agent-run): the bar says the agent works on three notes.
  mock.runs = { running: true, latest: running() };
  await emitSse(page, testInfo.testId, 'agent-run', { changeId: 11, runId: '0123456789abcdef', state: 'running' });
  const status = agentRun(page);
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute('data-state', 'running');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status.getByTestId('agent-run-text')).toHaveText('Agent is working on 3 notes');
  await expect(status.getByTestId('agent-run-log')).toHaveText('11-0123456789abcdef.log');
  await expect(status.getByTestId('agent-run-exit')).toHaveCount(0);

  // A run of another change moves nothing.
  mock.runs = { running: false, latest: { ...running(), state: 'failed', exitCode: 1, durationMs: 900 } };
  await emitSse(page, testInfo.testId, 'agent-run', { changeId: 99, runId: 'ffffffffffffffff', state: 'failed' });
  await page.waitForTimeout(500);
  await expect(status).toHaveAttribute('data-state', 'running');

  // It ends: the state, the exit code and the log's file name.
  mock.runs = { running: false, latest: { ...running(), state: 'done', exitCode: 0, durationMs: 4200 } };
  await emitSse(page, testInfo.testId, 'agent-run', { changeId: 11, runId: '0123456789abcdef', state: 'done' });
  await expect(status).toHaveAttribute('data-state', 'done');
  await expect(status.getByTestId('agent-run-text')).toHaveText('Agent finished');
  await expect(status.getByTestId('agent-run-exit')).toHaveText('exit 0');
  await expect(status.getByTestId('agent-run-log')).toHaveText('11-0123456789abcdef.log');
  await expect(status.getByTestId('agent-run-log')).toHaveAttribute('title', 'The run log, in the runs folder of your diffcity home');

  // A failure carries the daemon's message as the title.
  mock.runs = { running: false, latest: { ...running(), state: 'timeout', exitCode: null, durationMs: 1_800_000, message: 'stopped after 30 minutes' } };
  await emitSse(page, testInfo.testId, 'agent-run', { changeId: 11, runId: '0123456789abcdef', state: 'timeout' });
  await expect(status.getByTestId('agent-run-text')).toHaveText('Agent run timed out');
  await expect(status.getByTestId('agent-run-text')).toHaveAttribute('title', 'stopped after 30 minutes');
  await expect(status.getByTestId('agent-run-exit')).toHaveText('no exit code');
});

test('change/send-review-status: fallback-add-to-fix-queue', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL ?? 'http://127.0.0.1:4399').origin });
  const { api } = await openReview(page, { report, marks, wait: false });
  const preview = agentPreview({
    mode: null,
    argv: null,
    cwd: null,
    sessionId: null,
    session: null,
    token: null,
    refusals: [{ code: 'agent-launch-disabled', message: 'agent launch is off (agentLaunch.enabled in settings.json)' }],
  });
  api.agent(11).preview = preview;
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  const dialog = await openSendDialog(page);
  await expect(dialog.getByTestId('send-run')).toBeHidden();

  // Add to fix queue: the previewed summary goes in as one item, bound by its hash. While the request is in flight the
  // button is disabled, and a second click sends nothing; a second time it is already there.
  let release = (): void => undefined;
  api.agent(11).hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueButton = dialog.getByTestId('send-queue');
  await queueButton.click();
  await expect(dialog.getByTestId('send-status')).toHaveText('Adding to the fix queue…');
  await expect(queueButton).toBeDisabled();
  await queueButton.dispatchEvent('click');
  api.agent(11).hold = null;
  release();
  await expect(dialog.getByTestId('send-status')).toHaveText('Added to the fix queue (1 item waiting for /diffcity-review)');
  await expect(queueButton).toBeEnabled();
  expect(api.agent(11).writes.filter((write) => write.route === 'queue').map((write) => write.body)).toEqual([{ summaryHash: preview.summaryHash }]);
  await dialog.getByTestId('send-queue').click();
  await expect(dialog.getByTestId('send-status')).toHaveText('Already in the fix queue (1 item waiting for /diffcity-review)');

  // A refusal of the queue is said, not hidden.
  api.agent(11).failNext = { status: 409, code: 'fix-queue-full', message: 'the fix queue holds 100 items' };
  await dialog.getByTestId('send-queue').click();
  await expect(dialog.getByTestId('send-status')).toHaveText('Not added: the fix queue holds 100 items');

  // Copy puts exactly the previewed summary on the clipboard.
  await dialog.getByTestId('send-copy').click();
  await expect(dialog.getByTestId('send-status')).toHaveText('Copied');
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(preview.summary);
  // Nothing ran.
  expect(api.agent(11).writes.filter((write) => write.route === 'run')).toEqual([]);
  await expect(agentRun(page)).toBeHidden();
});

test('change/send-review-status: no status while the daemon refuses the runs read', async ({ page }) => {
  // The runs route refused (a page not on the daemon's own address): no status line, nothing written.
  const { api } = await openReview(page, { report, marks, wait: false });
  await page.route('**/api/changes/11/agent/runs', (route) => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'agent runs are for the daemon page only' } } }));
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  await expect(page.getByTestId('progress')).toBeVisible();
  await expect(agentRun(page)).toBeHidden();
  expect(api.agent(11).writes).toEqual([]);
});

standaloneTest('change/send-review-status: hidden-without-port', async ({ page, standalone }) => {
  await standalone.open(panelReport());
  await expect(page.getByTestId('hud-bar')).toBeVisible();
  await expect(page.locator('[data-testid="agent-run"], [data-testid="summary-send"], [data-testid="send-dialog"], [data-testid="review-summary"], [data-testid="send-to-agent"]')).toHaveCount(0);
});

test('change/send-review-status: survives-reload', async ({ page }) => {
  const { api } = await openReview(page, { report, marks, note: NOTE });
  const dialog = await openSendDialog(page);
  await scrollSummaryToEnd(page, dialog);
  await dialog.getByTestId('send-run').click();
  await expect(summaryDialog(page)).toBeHidden();
  await expect(page.getByTestId('agent-run-text')).toHaveText('Agent is working on 3 notes');
  const reads = api.count('/api/changes/11/agent/runs');

  // A reload reads the run back from GET runs: still running, same log.
  await page.reload();
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  await expect(page.getByTestId('agent-run-text')).toHaveText('Agent is working on 3 notes');
  await expect(page.getByTestId('agent-run-log')).toHaveText('11-0123456789abcdef.log');
  expect(api.count('/api/changes/11/agent/runs')).toBeGreaterThan(reads);

  // Ended while the page was away: a reload shows the end.
  api.agent(11).runs = { running: false, latest: { ...running(), state: 'failed', exitCode: 2, durationMs: 3000, message: 'claude reported an error' } };
  await page.reload();
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  await expect(page.getByTestId('agent-run-text')).toHaveText('Agent run failed');
  await expect(page.getByTestId('agent-run-exit')).toHaveText('exit 2');
});
