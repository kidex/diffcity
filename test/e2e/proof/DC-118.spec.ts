// Proof video for DC-118 (phase 4 T12): the rules engine against the real
// daemon from dist/, in a temporary home, on the invented `ledger` repo. A
// file-size rule in settings.json (severity high, maxLines 40) flags the large
// journal.ts and not the small fees.ts: the city draws the rule X on it, the
// check chip says "1 violation", the Rules filter counts it and the file is
// risky. "Mark as intended" takes the X and the risky verdict away and the
// state sticks on a new commit. Raising maxLines in settings.json recomputes
// the snapshot on the next collection and the chip says "passed".
// Recorded by `npm run proof -- DC-118`.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Report } from '../../../src/core/report/types.js';
import { createRepo } from '../../helpers/repo.js';
import { cli, getJson, stubEnv, until } from '../support/change-daemon.js';
import { effects } from '../support/effects.js';
import { criterion, expect, test, titleCard } from '../support/proof.js';
import { waitReady } from '../support/scene.js';

const JOURNAL = 'src/ledger/journal.ts';
const FEES = 'src/ledger/fees.ts';
const BRANCH = 'agent/journal';

function post(count: number): string {
  return ['export function post(entries: number[]): number {', ...Array.from({ length: count }, (_, i) => `  entries.push(${String(i)});`), '  return entries.length;', '}', ''].join('\n');
}

const ruleX = async (page: Page): Promise<string[]> =>
  (await effects(page)).markers.filter((marker) => marker.kind === 'x').map((marker) => `${marker.file}:${marker.severity ?? ''}`);

test('DC-118: a file-size rule from the settings marks a large file, and Mark as intended sticks', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-118: rules engine and the file-size rule', [
    'The real daemon from dist/, in a temporary home, on the invented ledger repo.',
    'settings.json: { id: "big-files", kind: "file-size", severity: "high", maxLines: 40 }.',
    'journal.ts grows to 63 lines, fees.ts stays one line.',
  ]);

  const repo = await createRepo({ name: 'ledger', files: { [JOURNAL]: post(5), [FEES]: 'export const fee = 1;\n', 'README.md': '# ledger\n' } });
  proof.onTeardown(() => repo.cleanup());
  await repo.branch(BRANCH);
  await repo.commit('grow journal', { [JOURNAL]: post(60), [FEES]: 'export const fee = 2;\n' });
  const settingsFile = join(proof.home, 'settings.json');
  const settings = (maxLines: number): string =>
    JSON.stringify({ v: 1, trustedRepos: [], rules: [{ id: 'big-files', kind: 'file-size', severity: 'high', maxLines }] }, null, 2);
  await mkdir(proof.home, { recursive: true });
  await writeFile(settingsFile, settings(40));

  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  await cli(['track', repo.dir], env);
  const base = proof.baseURL;
  const repoId = await until(async () => (await getJson<{ id: number; name: string }[]>(`${base}/api/repos`)).find((entry) => entry.name === 'ledger')?.id, 60_000, 'ledger in /api/repos');
  const change = await until(
    async () => (await getJson<{ changes: { id: number; ref: string; stats: unknown }[] }>(`${base}/api/repos/${String(repoId)}`)).changes.find((entry) => entry.ref.endsWith(BRANCH) && entry.stats !== null),
    60_000,
    'the agent/journal change with its first snapshot',
  );
  const reportUrl = `${base}/api/changes/${String(change.id)}/report`;
  const report = (): Promise<Report> => getJson<Report>(reportUrl);
  const verdictOf = async (path: string): Promise<string | undefined> => (await report()).packages.flatMap((pkg) => pkg.files).find((file) => file.path === path)?.verdict;

  const chip = page.getByRole('list', { name: 'Rule checks' }).getByRole('listitem');
  const rulesFilter = page.getByRole('group', { name: 'Filter by rule' });
  const riskyLabel = page.locator(`.roof.v-risky[data-building="${JOURNAL}"]`);
  const finding = (await report()).findings[0];
  if (finding === undefined) throw new Error('the rule finding is missing');
  const card = page.getByTestId('tab-findings-body').locator(`[data-testid="finding"][data-finding="${finding.id}"]`);

  await criterion(page, '1. The large file gets the rule X, the chip says violations, the Rules filter counts it', async () => {
    await page.goto(`${base}/?scene-debug#/change/${String(change.id)}`);
    await waitReady(page);
    await expect(chip).toHaveText(['big-files: 1 violation']);
    await expect(rulesFilter.getByRole('button', { name: /big-files/ })).toContainText('1');
    await expect.poll(() => ruleX(page)).toEqual([`${JOURNAL}:high`]);
  }, `${finding.title}: ${finding.message}`);

  await criterion(page, '2. An open high rule finding makes journal.ts risky; fees.ts stays fine', async () => {
    await expect(riskyLabel).toHaveCount(1);
    expect(await verdictOf(JOURNAL)).toBe('risky');
    expect(await verdictOf(FEES)).toBe('ok');
    await page.getByTestId('tab-findings').click();
    await expect(card).toBeVisible();
    await expect(card).toContainText('File over 40 lines');
  }, `id ${finding.id.slice(0, 40)}…, source rule:big-files`);

  await criterion(page, '3. Mark as intended: the X and the risky verdict go', async () => {
    await card.getByTestId('finding-intend').click();
    await expect(card).toHaveAttribute('data-state', 'intended');
    await expect.poll(() => ruleX(page)).toEqual([]);
    await expect(riskyLabel).toHaveCount(0);
    await expect.poll(() => verdictOf(JOURNAL)).toBe('ok');
  }, 'the served Report: state intended, journal.ts ok');

  await criterion(page, '4. A new commit: the rule finding comes back with the same id, still intended', async () => {
    const head = await repo.commit('note journal kinds', { [JOURNAL]: `${post(60)}// entry kinds\n` });
    await cli(['track', repo.dir], env);
    await until(async () => ((await report()).meta.head === head ? true : undefined), 60_000, 'the snapshot of the new head');
    const next = await report();
    expect(next.findings.map((entry) => [entry.id, entry.state])).toEqual([[finding.id, 'intended']]);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => ruleX(page)).toEqual([]);
    await expect(riskyLabel).toHaveCount(0);
  }, 'journal.ts now has 64 lines; same finding id, state intended');

  await criterion(page, '5. maxLines 40 → 100 in settings.json: the next collection recomputes, the chip says passed', async () => {
    await writeFile(settingsFile, settings(100));
    expect(await readFile(settingsFile, 'utf8')).toContain('"maxLines": 100');
    await cli(['track', repo.dir], env);
    await until(async () => ((await report()).checks?.[0]?.state === 'passed' ? true : undefined), 60_000, 'the passed check');
    await page.reload();
    await waitReady(page);
    await expect(chip).toHaveText(['big-files: passed']);
    await expect(rulesFilter).toBeHidden();
  }, 'same head, new settings: big-files passed, 0 findings');
});
