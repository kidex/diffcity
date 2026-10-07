// Proof video for DC-108 (phase 4 T9): the finding actions in the reading
// panel against the real daemon from dist/, in a temporary home. The
// order-discounts golden change gets an open high finding on
// OrdersService.place from two sources through `diffcity import`, which makes
// the service risky. "Ask agent to fix" writes it to the repo's fix queue and
// turns into "Queued"; "Mark as intended" takes the pin and the risky outline
// away (the refetched Report says so); Undo brings them back.
// Recorded by `npm run proof -- DC-108`.

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { Report } from '../../../src/core/report/types.js';
import { CLI_DIST } from '../../helpers/daemon.js';
import { getJson, SERVICE, stubEnv, trackScenario, until } from '../support/change-daemon.js';
import { effects } from '../support/effects.js';
import { criterion, expect, HOLD_MS, test, titleCard } from '../support/proof.js';
import { waitReady } from '../support/scene.js';

const TITLE = 'Discount is applied twice on a retried order';

/** Runs the built CLI in `cwd` to completion; rejects on a non-zero exit. */
function cliIn(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, ...args], { cwd, env, stdio: 'ignore' });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`diffcity ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

const highPins = async (page: Page): Promise<number> =>
  (await effects(page)).markers.filter((marker) => marker.kind === 'pin' && marker.file === SERVICE && marker.severity === 'high').length;

/** Puts `node` near the top of the panel's list, so the video shows it. */
async function showAtTop(page: Page, node: Locator): Promise<void> {
  await node.scrollIntoViewIfNeeded();
  const box = await node.boundingBox();
  const list = await page.getByTestId('panel-scroll').boundingBox();
  if (box === null || list === null) return;
  await page.evaluate(`document.querySelector('[data-testid="panel-scroll"]').scrollTop += ${String(Math.round(box.y - list.y - 8))}`);
}

test('DC-108: Ask agent to fix, Mark as intended and Undo on a finding card', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-108: finding actions in the reading panel', [
    'The real daemon from dist/, in a temporary home, on the invented order-discounts change.',
    'An imported high finding (claude and semgrep) makes orders.service.ts risky.',
    'Ask agent to fix turns into Queued; Mark as intended removes the pin and the risky outline; Undo brings them back.',
  ]);
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  const findingsFile = join(proof.root, 'findings.json');
  const entry = { severity: 'high', category: 'correctness', file: SERVICE, line: 14, title: TITLE, message: 'place() runs applyDiscount again when the insert is retried.' };
  await writeFile(findingsFile, JSON.stringify([{ ...entry, source: 'claude' }, { ...entry, source: 'semgrep' }]));
  await cliIn(tracked.repo.dir, ['import', findingsFile], env);
  const served = await until(
    async () => (await getJson<Report>(tracked.reportUrl)).findings.find((finding) => finding.title === TITLE),
    30_000,
    'the imported finding in the served Report',
  );
  const card = page.getByTestId('tab-findings-body').locator(`[data-testid="finding"][data-finding="${served.id}"]`);
  const verdict = page.getByTestId('tab-findings-body').locator(`[data-testid="group-file"][data-file="${SERVICE}"] .tag.verdict`);
  const riskyLabel = page.locator(`.roof.v-risky[data-building="${SERVICE}"]`);

  await criterion(page, '1. The imported finding: two sources, its file risky, a high pin on the city', async () => {
    await page.goto(tracked.url);
    await waitReady(page);
    await page.getByTestId('tab-findings').click();
    await showAtTop(page, card);
    await expect(card.getByTestId('finding-source')).toHaveText(['claude', 'semgrep']);
    await expect(verdict).toHaveClass(/\brisky\b/);
    await expect(riskyLabel).toHaveCount(1);
    await expect.poll(() => highPins(page)).toBe(1);
  }, `${served.id} on OrdersService.place, sources ${(served.sources ?? [served.source]).join(' + ')}`);

  await criterion(page, '2. Ask agent to fix: the daemon writes the fix queue, the button says Queued', async () => {
    await card.getByTestId('finding-ask').click();
    await expect(card.getByTestId('finding-ask')).toHaveText('Queued');
    await expect(card.getByTestId('finding-ask')).toBeDisabled();
    const queue = await readFile(join(tracked.repo.dir, '.diffcity', 'fix-queue.json'), 'utf8');
    expect(queue).toContain(served.id);
  }, '.diffcity/fix-queue.json now holds the finding');

  await criterion(page, '3. Mark as intended: the pin and the risky outline disappear', async () => {
    await card.getByTestId('finding-intend').click();
    await expect(card).toHaveAttribute('data-state', 'intended');
    await expect(card.getByTestId('finding-undo')).toBeVisible();
    await expect.poll(() => highPins(page)).toBe(0);
    await expect(verdict).toHaveClass(/\bok\b/);
    await expect(riskyLabel).toHaveCount(0);
    await page.waitForTimeout(HOLD_MS / 2);
  }, 'the refetched Report: state intended, orders.service.ts no longer risky');

  await criterion(page, '4. Undo: the finding is open again, the pin and the risky outline are back', async () => {
    await card.getByTestId('finding-undo').click();
    await expect(card).toHaveAttribute('data-state', 'open');
    await expect.poll(() => highPins(page)).toBe(1);
    await expect(verdict).toHaveClass(/\brisky\b/);
    await expect(riskyLabel).toHaveCount(1);
    await expect(card.getByTestId('finding-ask')).toHaveText('Queued');
  }, 'state open, orders.service.ts risky again; still queued for the agent');
});
