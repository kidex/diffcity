// e2e/findings/actions (DC-108, ADR-036): the finding cards' buttons against
// the mocked findings routes. "Ask agent to fix" queues the finding and turns
// into "Queued"; "Mark as intended" writes the state and the refetched Report
// takes the pin, the pulse and the risky verdict away; Undo puts them back.
// Without a FindingsPort (the HTML export) there are no buttons; a refusal
// shows the daemon's reason; finding texts and reasons are inert.

import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import {
  askButton,
  cardIn,
  HIGH,
  HIGH_TITLE,
  intendButton,
  MED,
  mixedReport,
  openFindings,
  pinsOn,
  pulses,
  RULE,
  SERVICE,
  tabCard,
  undoButton,
  verdictCount,
} from '../../support/findings.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { test as standaloneTest } from '../../support/standalone.js';

test.describe.configure({ timeout: 90_000 });

test('findings/actions/ask-fix-queues-and-marks-queued', async ({ page }) => {
  const { api } = await openFindings(page);
  const queue = api.findings(11);
  // The daemon already has the medium one in the queue: it answers `queued: false`.
  queue.queued.add(MED);
  await page.getByTestId('tab-findings').click();

  const card = tabCard(page, HIGH);
  await expect(askButton(card)).toHaveText('Ask agent to fix');
  await expect(askButton(card)).toHaveAccessibleName(`Ask agent to fix: ${HIGH_TITLE}`);
  await expect(askButton(card)).toBeEnabled();
  await askButton(card).click();
  await expect(askButton(card)).toHaveText('Queued');
  await expect(askButton(card)).toHaveAttribute('aria-disabled', 'true');
  await expect(askButton(card)).toBeFocused();
  expect(queue.writes).toEqual([{ method: 'POST', key: HIGH, action: 'fix', body: null }]);
  // Queued is inert (Playwright will not click it unless forced): a click and Enter send nothing; the finding stays open.
  await expect(askButton(card)).toBeDisabled();
  await askButton(card).click({ force: true });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(queue.writes).toHaveLength(1);
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(intendButton(card)).toBeEnabled();

  // Already queued reads the same; by keyboard.
  const med = tabCard(page, MED);
  await askButton(med).focus();
  await page.keyboard.press('Enter');
  await expect(askButton(med)).toHaveText('Queued');

  // A rule finding is queued too, its key (with `:`) one path segment.
  const rule = tabCard(page, RULE);
  await askButton(rule).click();
  await expect(askButton(rule)).toHaveText('Queued');
  expect(queue.writes.map((write) => write.key)).toEqual([HIGH, MED, RULE]);
  expect(api.requests.filter((url) => url.pathname.endsWith('/fix')).map((url) => url.pathname)).toContain('/api/changes/11/findings/rule%3Afile-size%3A7d3e9a10/fix');

  // The stop card of the same finding, in the Execution order tab, says Queued as well.
  await page.getByTestId('tab-order').click();
  const stop = cardIn(page.getByTestId('tab-order-body'), HIGH);
  await expect(askButton(stop)).toHaveText('Queued');
});

test('findings/actions/mark-intended-removes-pin-and-risky', async ({ page }) => {
  const { api } = await openFindings(page);
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);
  const head = page.getByTestId('tab-findings-body').locator(`[data-testid="group-file"][data-file="${SERVICE}"] .tag.verdict`);
  // Before: the high pin, the pulse and the risky verdict on the service.
  await expect.poll(() => pinsOn(page, SERVICE)).toContain('high');
  expect(await pulses(page, SERVICE)).toBe(true);
  await expect(head).toHaveClass(/\brisky\b/);
  await expect(verdictCount(page, 'risky')).toHaveText('1');
  await expect(page.locator(`.roof.v-risky[data-building="${SERVICE}"]`)).toHaveCount(1);
  const reads = api.count('/api/changes/11/report');

  await intendButton(card).click();
  expect(api.findings(11).writes).toEqual([{ method: 'PUT', key: HIGH, action: 'state', body: { state: 'intended' } }]);
  // The refetched Report says intended: the card, its state, and Undo with the focus on it.
  await expect.poll(() => api.count('/api/changes/11/report')).toBeGreaterThan(reads);
  await expect(card).toHaveAttribute('data-state', 'intended');
  await expect(card.getByTestId('finding-state')).toHaveText('intended');
  await expect(undoButton(card)).toBeFocused();
  await expect(askButton(card)).toHaveCount(0);
  await expect(intendButton(card)).toHaveCount(0);
  // ...and the city follows the Report: no high pin, no pulse, the outline and the label no longer risky.
  await expect.poll(() => pinsOn(page, SERVICE)).not.toContain('high');
  await expect.poll(() => pulses(page, SERVICE)).toBe(false);
  await expect(head).toHaveClass(/\bok\b/);
  await expect(verdictCount(page, 'risky')).toHaveText('0');
  await expect(page.locator(`.roof.v-risky[data-building="${SERVICE}"]`)).toHaveCount(0);
  // The medium finding on the same file is untouched.
  await expect(tabCard(page, MED)).toHaveAttribute('data-state', 'open');
});

test('findings/actions/undo-intended', async ({ page }) => {
  const { api } = await openFindings(page);
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);
  await intendButton(card).click();
  await expect(undoButton(card)).toBeVisible();
  await expect(undoButton(card)).toHaveAccessibleName(`Undo mark as intended: ${HIGH_TITLE}`);
  await expect.poll(() => pinsOn(page, SERVICE)).not.toContain('high');

  // Undo by keyboard: the focus is on it already.
  await expect(undoButton(card)).toBeFocused();
  await page.keyboard.press('Enter');
  expect(api.findings(11).writes.map((write) => write.body)).toEqual([{ state: 'intended' }, { state: 'open' }]);
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(undoButton(card)).toHaveCount(0);
  await expect(intendButton(card)).toBeEnabled();
  await expect(askButton(card)).toBeFocused();
  await expect.poll(() => pinsOn(page, SERVICE)).toContain('high');
  await expect.poll(() => pulses(page, SERVICE)).toBe(true);
  await expect(page.getByTestId('tab-findings-body').locator(`[data-testid="group-file"][data-file="${SERVICE}"] .tag.verdict`)).toHaveClass(/\brisky\b/);
  await expect(verdictCount(page, 'risky')).toHaveText('1');

  // A finding intended before this session offers no Undo.
  await expect(tabCard(page, 'f:3c4d5e6f7a8192a3').locator('button')).toHaveCount(0);
});

const NO_ACTIONS = '[data-testid="finding-ask"], [data-testid="finding-intend"], [data-testid="finding-undo"], [data-testid="finding-error"]';

standaloneTest('findings/actions/buttons-hidden-without-port', async ({ page, standalone }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await standalone.open(mixedReport());
  await page.getByTestId('tab-findings').click();
  await expect(page.getByTestId('finding')).toHaveCount(5);
  // The cards keep their state and sources, with no buttons at all: not even the disabled placeholders.
  await expect(page.locator(NO_ACTIONS)).toHaveCount(0);
  await expect(page.getByTestId('reading-panel').getByRole('button', { name: /ask agent to fix|mark as intended|undo/i })).toHaveCount(0);
  await expect(page.locator('[data-testid="finding-actions"]:not([hidden])')).toHaveCount(0);
  await expect(page.getByTestId('reading-panel').locator('[title="Arrives in a later version"]')).toHaveCount(0);
  await expect(cardIn(page.getByTestId('tab-findings-body'), HIGH).getByTestId('finding-source')).toHaveText(['claude', 'semgrep']);
  await expect(cardIn(page.getByTestId('tab-findings-body'), 'f:3c4d5e6f7a8192a3').getByTestId('finding-state')).toHaveText('intended');
});

test('findings/actions/hostile-finding-text-inert', async ({ page }) => {
  const report: Report = mixedReport();
  const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  const high = report.findings.find((finding) => finding.id === HIGH);
  if (high === undefined) throw new Error('fixture changed');
  high.title = `Title ${hostile}`;
  high.message = `Message ${hostile}`;
  high.source = `src${hostile}`;
  high.sources = [high.source, `other${hostile}`];
  const { api } = await openFindings(page, { report });
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);
  await expect(card.locator('.t')).toContainText(`Title ${hostile}`);
  await expect(card.locator('.m')).toHaveText(`Message ${hostile}`);
  await expect(card.getByTestId('finding-source')).toHaveText([`src${hostile}`, `other${hostile}`]);
  await expect(askButton(card)).toHaveAccessibleName(`Ask agent to fix: Title ${hostile}`);

  // A refusal whose message carries markup is shown as text.
  api.findings(11).failNext = { status: 409, code: 'fix-queue-invalid', message: `Queue is broken ${hostile}` };
  await askButton(card).click();
  await expect(card.getByTestId('finding-error')).toHaveText(`Queue is broken ${hostile}`);
  await expect(page.getByTestId('reading-panel').locator('img, script')).toHaveCount(0);
  expect(await page.evaluate('window.__pwned')).toBeUndefined();
});

test('findings/actions/fix-queue-unsafe-reason-shown', async ({ page }) => {
  const { api } = await openFindings(page);
  const queue = api.findings(11);
  await page.getByTestId('tab-findings').click();
  const card = tabCard(page, HIGH);

  const unsafe = 'The fix queue .diffcity/fix-queue.json is a symlink: diffcity will not write through it.';
  queue.failNext = { status: 409, code: 'fix-queue-unsafe', message: unsafe };
  await askButton(card).click();
  const reason = card.getByTestId('finding-error');
  await expect(reason).toHaveText(unsafe);
  await expect(reason).toHaveAttribute('role', 'alert');
  // Nothing was queued: the button is still there to try again, and keeps the focus.
  await expect(askButton(card)).toHaveText('Ask agent to fix');
  await expect(askButton(card)).toBeEnabled();
  await expect(askButton(card)).toBeFocused();

  // no-working-tree, on Mark as intended's neighbour: the reason is the daemon's.
  const noTree = 'The change is not checked out in a working tree: there is nowhere to write the fix queue.';
  queue.failNext = { status: 409, code: 'no-working-tree', message: noTree };
  await askButton(card).click();
  await expect(reason).toHaveText(noTree);

  // Any other answer of the daemon shows its message too: the finding is gone from the latest snapshot.
  const gone = `No finding ${HIGH} in change 11.`;
  queue.failNext = { status: 404, code: 'finding-not-found', message: gone };
  await askButton(card).click();
  await expect(reason).toHaveText(gone);
  // The write guard refused the page's origin: it says where to open diffcity.
  queue.failNext = { status: 403, code: 'cross-site', message: 'cross-site write refused' };
  await askButton(card).click();
  await expect(reason).toHaveText('Open diffcity from the address `diffcity start` prints.');

  // A dropped connection (no answer at all): the generic line, then a retry that works clears it.
  queue.dropNext = true;
  await askButton(card).click();
  await expect(reason).toHaveText('Could not reach the diffcity daemon. Try again.');
  await askButton(card).click();
  await expect(askButton(card)).toHaveText('Queued');
  await expect(reason).toHaveCount(0);

  // A refused state write leaves the finding open, with its reason.
  queue.failNext = { status: 409, code: 'archived', message: 'This change is archived.' };
  await intendButton(card).click();
  await expect(reason).toHaveText('This change is archived.');
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(intendButton(card)).toBeEnabled();
});
