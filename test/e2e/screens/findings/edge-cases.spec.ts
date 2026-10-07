// e2e/findings/edge-cases (DC-108, ADR-036): the finding actions under the
// timings and inputs a reviewer can produce: double clicks, a click while the
// refetch after a write is still in flight, SSE `findings` arriving before the
// write's answer, two findings acted on in quick succession, a key holding
// `:` and `/`, a daemon that goes away after a write and comes back, the 409
// `archived` refusal on Undo, and keyboard-only use with the names a screen
// reader reads.

import type { Page, Route } from '@playwright/test';
import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { askButton, HIGH, HIGH_TITLE, intendButton, MED, mixedReport, openFindings, pinsOn, SERVICE, tabCard, undoButton, verdictCount } from '../../support/findings.js';
import { setFindingState } from '../../support/findings-api.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { emitSse, tagClient } from '../../support/sse.js';

test.describe.configure({ timeout: 90_000 });

/** A promise with its resolver, to hold a request until the spec lets it go. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const REPORT = '/api/changes/11/report';

/**
 * Holds every Report fetch of change 11 while `held()` is true; the request
 * then goes on to the mock API (registered earlier, so it answers the fallback).
 * Resolves `release` to let the held ones through.
 */
async function holdReports(page: Page): Promise<{ hold(): void; release(): void; held(): number }> {
  let current: ReturnType<typeof gate> | null = null;
  let waiting = 0;
  await page.route(
    (url) => url.pathname === REPORT,
    async (route: Route) => {
      const holding = current;
      if (holding === null) return route.fallback();
      waiting += 1;
      await holding.promise;
      waiting -= 1;
      try {
        await route.fallback();
      } catch {
        // The page aborted the request while it was held.
      }
    },
  );
  return {
    hold: () => {
      current = gate();
    },
    release: () => {
      const holding = current;
      current = null;
      holding?.open();
    },
    held: () => waiting,
  };
}

test('findings/edge-cases/double-click-sends-one-write-per-button', async ({ page }) => {
  const { api } = await openFindings(page);
  const mock = api.findings(11);
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);

  await askButton(card).dblclick();
  await expect(askButton(card)).toHaveText('Queued');
  await page.waitForTimeout(300);
  expect(mock.writes).toEqual([{ method: 'POST', key: HIGH, action: 'fix', body: null }]);

  // Held, so the second click lands while the first is in flight.
  const slow = gate();
  mock.hold = slow.promise;
  await intendButton(card).dblclick();
  await expect(intendButton(card)).toHaveAttribute('aria-disabled', 'true');
  slow.open();
  mock.hold = null;
  await expect(undoButton(card)).toBeEnabled();
  await page.waitForTimeout(300);
  expect(mock.writes.filter((write) => write.action === 'state')).toHaveLength(1);

  // Not held: the answer and the refetch race the second click.
  await undoButton(card).dblclick();
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(intendButton(card)).toBeEnabled();
  await page.waitForTimeout(300);
  expect(mock.writes.map((write) => write.body)).toEqual([null, { state: 'intended' }, { state: 'open' }]);
});

test('findings/edge-cases/click-while-refetch-pending', async ({ page }) => {
  const { api } = await openFindings(page);
  const mock = api.findings(11);
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);
  const reports = await holdReports(page);

  // Mark is answered, its refetch is held: Undo is shown but inert, a click sends nothing.
  reports.hold();
  await intendButton(card).click();
  await expect.poll(() => reports.held()).toBeGreaterThan(0);
  await expect(undoButton(card)).toHaveAttribute('aria-disabled', 'true');
  await undoButton(card).click({ force: true });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(mock.writes).toHaveLength(1);
  // The other finding on the same file is not held up.
  await askButton(tabCard(page, MED)).click();
  await expect(askButton(tabCard(page, MED))).toHaveText('Queued');
  // Ask agent to fix on the marked one, while its refetch is pending: it is gone from the card.
  await expect(askButton(card)).toHaveCount(0);

  reports.release();
  await expect(card).toHaveAttribute('data-state', 'intended');
  await expect(undoButton(card)).toBeEnabled();
  expect(mock.writes.map((write) => [write.action, write.key])).toEqual([
    ['state', HIGH],
    ['fix', MED],
  ]);
});

test('findings/edge-cases/sse-before-write-answer', async ({ page }, testInfo) => {
  const { api, reports } = await openFindings(page, { wait: false });
  await tagClient(page, testInfo.testId);
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
  const mock = api.findings(11);
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);

  // The daemon wrote the state and signalled it, but its HTTP answer is late.
  const slow = gate();
  mock.hold = slow.promise;
  await intendButton(card).click();
  await expect.poll(() => mock.writes.length).toBe(1);
  const served = reports[11];
  if (served === undefined) throw new Error('no Report for change 11');
  setFindingState(served, HIGH, 'intended');
  const reads = api.count(REPORT);
  expect(await emitSse(page, testInfo.testId, 'findings', { repoId: 1, changeId: 11 })).toBeGreaterThan(0);
  await expect.poll(() => api.count(REPORT)).toBeGreaterThan(reads);
  await expect(card).toHaveAttribute('data-state', 'intended');
  await expect.poll(() => pinsOn(page, SERVICE)).not.toContain('high');

  // The answer arrives: Undo is offered and works.
  slow.open();
  mock.hold = null;
  await expect(undoButton(card)).toBeEnabled();
  await undoButton(card).click();
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect.poll(() => pinsOn(page, SERVICE)).toContain('high');
});

test('findings/edge-cases/two-findings-in-quick-succession', async ({ page }) => {
  const { api } = await openFindings(page);
  const mock = api.findings(11);
  await page.getByTestId('tab-findings').click();
  const high = tabCard(page, HIGH);
  const med = tabCard(page, MED);

  await intendButton(high).click();
  await intendButton(med).click();
  await expect(high).toHaveAttribute('data-state', 'intended');
  await expect(med).toHaveAttribute('data-state', 'intended');
  await expect(undoButton(high)).toBeEnabled();
  await expect(undoButton(med)).toBeEnabled();
  await expect(verdictCount(page, 'risky')).toHaveText('0');
  expect(mock.writes.map((write) => write.key)).toEqual([HIGH, MED]);

  await undoButton(med).click();
  await undoButton(high).click();
  await expect(high).toHaveAttribute('data-state', 'open');
  await expect(med).toHaveAttribute('data-state', 'open');
  await expect(verdictCount(page, 'risky')).toHaveText('1');
});

test('findings/edge-cases/key-with-colon-and-slash', async ({ page }) => {
  const report: Report = mixedReport();
  const key = 'imp:scanner/rule:a/b?c#d%2F';
  const finding = report.findings.find((candidate) => candidate.id === HIGH);
  if (finding === undefined) throw new Error('fixture changed');
  finding.id = key;
  const { api } = await openFindings(page, { report });
  const mock = api.findings(11);
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, key);

  await askButton(card).click();
  await expect(askButton(card)).toHaveText('Queued');
  await intendButton(card).click();
  await expect(card).toHaveAttribute('data-state', 'intended');
  await expect(undoButton(card)).toBeFocused();
  expect(mock.writes.map((write) => write.key)).toEqual([key, key]);
  const paths = api.requests.filter((url) => url.pathname.includes('/findings/')).map((url) => url.pathname);
  expect(paths).toEqual([`/api/changes/11/findings/${encodeURIComponent(key)}/fix`, `/api/changes/11/findings/${encodeURIComponent(key)}/state`]);
});

test('findings/edge-cases/daemon-away-after-write-then-back', async ({ page }, testInfo) => {
  const { api, reports } = await openFindings(page, { wait: false });
  await tagClient(page, testInfo.testId);
  await page.goto('/?scene-debug#/change/11');
  await page.waitForFunction('window.diffcityScene !== undefined && window.diffcityScene.ready === true');
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);

  // The write is answered, then the daemon is gone: the refetch gets no answer.
  let away = true;
  await page.route(
    (url) => url.pathname === REPORT,
    (route) => (away ? route.abort('connectionrefused') : route.fallback()),
  );
  await intendButton(card).click();
  await expect.poll(() => api.findings(11).writes.length).toBe(1);
  // The change stays on screen with the last Report; the card waits, inert.
  await page.waitForTimeout(500);
  await expect(page.getByTestId('tab-findings-body')).toBeVisible();
  await expect(undoButton(card)).toHaveAttribute('aria-disabled', 'true');

  // The daemon is back and says so: the Report is refetched and the card settles.
  away = false;
  expect(reports[11]?.findings.find((finding) => finding.id === HIGH)?.state).toBe('intended');
  expect(await emitSse(page, testInfo.testId, 'hello', { version: 'test', startedAt: new Date().toISOString() })).toBeGreaterThan(0);
  await expect(card).toHaveAttribute('data-state', 'intended');
  await expect(undoButton(card)).toBeEnabled();
  await undoButton(card).click();
  await expect(card).toHaveAttribute('data-state', 'open');
});

test('findings/edge-cases/archived-refusal-on-undo', async ({ page }) => {
  const { api } = await openFindings(page);
  const mock = api.findings(11);
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);
  await intendButton(card).click();
  await expect(undoButton(card)).toBeEnabled();

  mock.failNext = { status: 409, code: 'archived', message: 'Change 11 is archived.' };
  await undoButton(card).click();
  await expect(card.getByTestId('finding-error')).toHaveText('Change 11 is archived.');
  await expect(card).toHaveAttribute('data-state', 'intended');
  await expect(undoButton(card)).toBeEnabled();
  await expect(undoButton(card)).toBeFocused();

  mock.failNext = { status: 409, code: 'archived', message: 'Change 11 is archived.' };
  const med = tabCard(page, MED);
  await askButton(med).click();
  await expect(med.getByTestId('finding-error')).toHaveText('Change 11 is archived.');
  await expect(askButton(med)).toHaveText('Ask agent to fix');
});

test('findings/edge-cases/keyboard-only-and-names', async ({ page }) => {
  const { api } = await openFindings(page);
  const mock = api.findings(11);
  await page.getByTestId('tab-findings').focus();
  await page.keyboard.press('Enter');
  const card = tabCard(page, HIGH);

  // Tab reaches the first card's buttons; the names say which finding they act on.
  const ask = askButton(card);
  for (let step = 0; step < 60; step += 1) {
    if (await page.evaluate<boolean>(`document.activeElement?.dataset?.testid === 'finding-ask' && document.activeElement.closest('[data-finding]')?.dataset.finding === '${HIGH}'`)) break;
    await page.keyboard.press('Tab');
  }
  await expect(ask).toBeFocused();
  await expect(ask).toHaveRole('button');
  await expect(ask).toHaveAccessibleName(`Ask agent to fix: ${HIGH_TITLE}`);
  await expect(intendButton(card)).toHaveAccessibleName(`Mark as intended: ${HIGH_TITLE}`);

  await page.keyboard.press('Space');
  await expect(ask).toHaveText('Queued');
  await expect(ask).toHaveAccessibleName(`Queued: ${HIGH_TITLE}`);
  await expect(ask).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(intendButton(card)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(undoButton(card)).toBeFocused();
  await expect(undoButton(card)).toHaveAccessibleName(`Undo mark as intended: ${HIGH_TITLE}`);
  // Inert until the refetched Report says intended; the focus stays on it meanwhile.
  await expect(card).toHaveAttribute('data-state', 'intended');
  await expect(undoButton(card)).toBeEnabled();
  await expect(undoButton(card)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('data-state', 'open');
  // Back to the first button, which still says Queued.
  await expect(ask).toBeFocused();
  expect(mock.writes.map((write) => write.body)).toEqual([null, { state: 'intended' }, { state: 'open' }]);

  // A refusal is announced.
  mock.failNext = { status: 409, code: 'no-working-tree', message: 'Not checked out in a working tree.' };
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Not checked out in a working tree.' })).toHaveCount(1);
});
