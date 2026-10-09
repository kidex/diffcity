// e2e/session/tab-cards (ADR-038): the reading panel's Session tab, from the
// mocked GET /api/changes/:id/sessions. Hidden while the change has no
// sessions (and shown once SSE `sessions` says there are some); one card per
// session, newest first, with its prompts, questions and the agents that ran;
// an agent row expands to its report and activity with Enter or Space; an
// edited file the Report has selects its building; `here` marks the runs that
// worked in this change's working tree; session text is inert; an unreadable
// session shows only that it could not be read; a stale one keeps its data
// under an "out of date" note.

import { test, type Page } from '@playwright/test';
import type { SessionsResponse } from '../../../../src/core/model/types.js';
import { GUARD, SERVICE } from '../../support/hud.js';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { attributesOf, openPanel, panel, panelReport, tab } from '../../support/panel.js';
import { sceneExpect as expect, waitForCityAttribute, waitReady } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

const sessionTab = (page: Page) => page.getByTestId('tab-session');
const cards = (page: Page) => page.getByTestId('session-card');

async function openSessions(page: Page, sessions: SessionsResponse = fixtures.sessionsTwo()): Promise<void> {
  await openPanel(page, panelReport(), { sessions: { 11: sessions } });
  await expect(sessionTab(page)).toBeVisible();
  await sessionTab(page).click();
  await expect(page.getByTestId('tab-session-body')).toBeVisible();
}

test('session/tab-cards/tab-hidden-without-sessions', async ({ page }, testInfo) => {
  const sessions: Record<number, SessionsResponse> = { 11: { sessions: [], total: 0 } };
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await mockApi(page, { reports: { 11: panelReport() }, sessions });
  await tagClient(page, testInfo.testId);
  await page.goto('/?scene-debug#/change/11');
  await waitReady(page);
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  // No sessions: the four tabs of the Report only.
  await expect(page.getByTestId('panel-tabs').getByRole('button')).toHaveCount(4);
  await expect(sessionTab(page)).toHaveCount(0);

  // A session was linked: SSE `sessions` for this change brings the tab, with its counter.
  sessions[11] = fixtures.sessionsTwo();
  expect(await emitSse(page, testInfo.testId, 'sessions', { changeId: 11 })).toBeGreaterThan(0);
  await expect(sessionTab(page)).toBeVisible();
  await expect(page.getByTestId('count-session')).toHaveText('2');
  await expect(page.getByTestId('panel-tabs').getByRole('button')).toHaveText([/^Execution order/, /^Findings/, /^Outside the spec/, /^Symbols/, /^Session/]);

  // Gone again while the tab is open: back to Execution order.
  await sessionTab(page).click();
  await expect(cards(page)).toHaveCount(2);
  sessions[11] = { sessions: [], total: 0 };
  await emitSse(page, testInfo.testId, 'sessions', { changeId: 11 });
  await expect(sessionTab(page)).toHaveCount(0);
  await expect(tab(page, 'order')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tab-order-body')).toBeVisible();
});

test('session/tab-cards/card-prompts-questions-agents', async ({ page }) => {
  await openSessions(page);
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByTestId('session-title')).toHaveText(['Add percentage discounts to orders', 'Untitled session']);
  const first = cards(page).first();
  await expect(first.getByTestId('session-range')).toContainText('2026');
  await expect(first.getByTestId('session-prompt')).toHaveText([/^Add percentage discounts to orders\. Keep the guard strict/, '/review']);
  await expect(first.getByTestId('question-text')).toHaveText(['Round discounted totals per line or per order?', 'Backfill the new column for open orders?']);
  await expect(first.getByTestId('question-answer')).toHaveText(['Per order', 'Not answered']);
  await expect(first.getByTestId('run-type')).toHaveText(['Plan', 'general-purpose', 'Explore']);
  await expect(first.getByTestId('run-description')).toHaveText(['Plan the discount rules', 'Implement the discount service', 'Find the callers of place()']);
  await expect(first.getByTestId('run-duration')).toHaveText(['1 min 35 s', '≈ 5 min 12 s']);
  await expect(first.getByTestId('run-status')).toHaveText(['completed', 'completed', 'running']);
  // The Explore run was launched by the implementer: indented under it.
  // Only the first card has runs.
  expect(await attributesOf(page, 'session-run', 'data-depth')).toEqual(['0', '0', '1']);
  const left = await page.evaluate<number[]>(`[...document.querySelectorAll('[data-testid="run-type"]')].map((node) => node.getBoundingClientRect().left)`);
  expect(left[2]).toBeGreaterThan(left[1] ?? 0);
  await expect(first.getByTestId('session-elsewhere')).toHaveText('2 runs in other working trees');
  await expect(first.getByTestId('session-main').getByTestId('activity-chip')).toHaveText(['Edits 1', 'Reads and searches 3', 'Shell 1', 'Subagents 3']);
  await expect(first.getByTestId('session-wide-heading')).toHaveText('Edited files, whole session');
  await expect(first.getByTestId('session-wide').getByTestId('edited-outside')).toHaveText('1 file outside the repo');
});

test('session/tab-cards/agent-row-expands-report-and-activity', async ({ page }) => {
  await openSessions(page);
  const run = cards(page).first().getByTestId('session-run').nth(1);
  const toggle = run.getByTestId('run-toggle');
  const detail = run.getByTestId('run-detail');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(detail).toBeHidden();
  // Keyboard: Enter opens, Space closes.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('run-report')).toHaveText('Added applyDiscount to OrdersService and the rules module. Tests pass.');
  await expect(detail.getByTestId('run-status-source')).toHaveText('Status from the task notification');
  await expect(detail.getByTestId('activity-chip')).toHaveText(['Edits 3', 'Shell 2', 'MCP tracker 1']);
  await expect(detail.getByTestId('edited-file')).toHaveText([SERVICE, 'src/services/orders/discount.rules.ts', 'docs/discounts.md']);
  expect(await toggle.getAttribute('aria-controls')).toBe(await detail.getAttribute('id'));
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(detail).toBeHidden();
  // A click opens it too, and a refetch keeps it open with the focus on it.
  await toggle.click();
  await expect(detail).toBeVisible();
  await tab(page, 'order').click();
  await sessionTab(page).click();
  await expect(cards(page).first().getByTestId('run-toggle').nth(1)).toHaveAttribute('aria-expanded', 'true');
});

test('session/tab-cards/edited-file-click-selects-building', async ({ page }) => {
  await openSessions(page);
  const wide = cards(page).first().getByTestId('session-wide');
  await wide.locator(`[data-testid="edited-file"][data-path="${GUARD}"]`).click();
  await waitForCityAttribute(page, 'data-selected', GUARD);
  // The tab stays: selecting is not opening the file view.
  await expect(page.getByTestId('tab-session-body')).toBeVisible();
  // A file the Report does not have is text, not a button.
  await expect(wide.locator('[data-testid="edited-file"][data-path="docs/discounts.md"]')).toHaveCount(1);
  await expect(wide.locator('span[data-testid="edited-file"][data-path="docs/discounts.md"]')).toHaveCount(1);
  await wide.locator(`[data-testid="edited-file"][data-path="${SERVICE}"]`).focus();
  await page.keyboard.press('Enter');
  await waitForCityAttribute(page, 'data-selected', SERVICE);
});

test('session/tab-cards/here-marker-on-runs', async ({ page }) => {
  await openSessions(page);
  const first = cards(page).first();
  await expect(first.getByTestId('session-here')).toHaveText('here');
  expect(await attributesOf(page, 'session-run', 'data-here')).toEqual(['true', 'true', 'false']);
  await expect(first.getByTestId('run-here')).toHaveCount(2);
  await expect(first.getByTestId('session-run').nth(2).getByTestId('run-here')).toHaveCount(0);
  // The second session ran elsewhere.
  await expect(cards(page).nth(1).getByTestId('session-here')).toHaveCount(0);
});

test('session/tab-cards/hostile-text-inert', async ({ page }) => {
  const IMG = '<img src=x onerror=window.__pwned=1>';
  const SCRIPT = '<script>window.__pwned=2</script>';
  const SVG = '"><svg onload=window.__pwned=3>';
  const sessions = fixtures.sessionsTwo();
  const session = sessions.sessions[0];
  const digest = session?.digest;
  if (session === undefined || digest === null || digest === undefined) throw new Error('fixture session missing');
  session.title = `${SCRIPT} title`;
  const prompt = digest.prompts[0];
  const question = digest.questions[0];
  const run = digest.runs[1];
  if (prompt === undefined || question === undefined || run === undefined) throw new Error('fixture parts missing');
  prompt.text = `${IMG} prompt`;
  question.header = SVG;
  question.question = `${SCRIPT} question`;
  question.answer = `${IMG} answer`;
  run.type = SVG;
  run.description = `${IMG} description`;
  run.report = `${SCRIPT}${IMG} report`;
  run.activity.mcp = { [SVG]: 1 };
  digest.sessionWide.files.push(`src/${IMG}.ts`);
  await openSessions(page, sessions);
  const first = cards(page).first();
  await first.getByTestId('run-toggle').nth(1).click();
  await expect(first.getByTestId('session-title')).toHaveText(`${SCRIPT} title`);
  await expect(first.getByTestId('session-prompt').first()).toHaveText(`${IMG} prompt`);
  await expect(first.getByTestId('question-header').first()).toHaveText(SVG);
  await expect(first.getByTestId('question-answer').first()).toHaveText(`${IMG} answer`);
  await expect(first.getByTestId('run-type').nth(1)).toHaveText(SVG);
  await expect(first.getByTestId('run-report').nth(1)).toHaveText(`${SCRIPT}${IMG} report`);
  await expect(first.getByTestId('session-wide')).toContainText(`src/${IMG}.ts`);
  await expect(panel(page).locator('img, script, svg, [onerror], [onload]')).toHaveCount(0);
  expect(await page.evaluate('window.__pwned')).toBeUndefined();
});

test('session/tab-cards/parse-error-state', async ({ page }) => {
  await openSessions(page, fixtures.sessionsParseError());
  await expect(cards(page)).toHaveCount(1);
  const card = cards(page).first();
  await expect(card).toHaveAttribute('data-state', 'unreadable');
  await expect(card.getByTestId('session-title')).toHaveText('Untitled session');
  await expect(card.getByTestId('session-unreadable')).toHaveText('Session data could not be read');
  await expect(card.locator('[data-testid="session-prompts"], [data-testid="session-questions"], [data-testid="session-runs"], [data-testid="session-wide"]')).toHaveCount(0);
});

test('session/tab-cards/stale-note', async ({ page }) => {
  await openSessions(page);
  const stale = cards(page).nth(1);
  await expect(stale).toHaveAttribute('data-state', 'stale');
  await expect(stale.getByTestId('session-note')).toHaveText(/^Out of date/);
  // The data is still shown.
  await expect(stale.getByTestId('session-prompt')).toHaveText('Write the migration for the discount column.');
  await expect(stale.getByTestId('edited-file')).toHaveText('db/migrations/20260921_order_discounts.sql');
  // The fresh one has no note.
  await expect(cards(page).first().getByTestId('session-note')).toHaveCount(0);
});
