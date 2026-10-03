// Proof video for DC-77 (ADR-026, the change screen HUD): the real daemon from
// dist/, in a temporary home, tracks the invented sample-bakery repo whose
// branch feature/order-notes touches files in three packages, one of them the
// tier 1 src/auth. The change opens as a city with its HUD: the top bar with
// the counters and the "need your eyes" badge, the verdict and type filters
// that dim what they filter out, the tooltip on hover, the selection card, and
// a live update when a commit lands on the branch while the screen is open:
// the buildings move and grow, a new one rises. Recorded by
// `npm run proof -- DC-77`.

import { spawn } from 'node:child_process';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';
import { paintDump } from '../support/hud.js';
import { project, stats, waitForCityAttribute, waitReady } from '../support/scene.js';

const TITLE = 'add notes to orders';
const SESSION = 'src/auth/session.ts';
const NOTES = 'src/orders/notes.ts';
const RECEIPT = 'src/orders/receipt.ts';

/** sample-bakery on main, with feature/order-notes one commit ahead across src/auth, src/orders and src/menu. */
async function buildSampleBakery(): Promise<Awaited<ReturnType<typeof createRepo>>> {
  const repo = await createRepo({
    name: 'sample-bakery',
    files: {
      'src/auth/session.ts': 'export function openSession(user: string): string {\n  return user;\n}\n\nexport function closeSession(): void {}\n',
      'src/auth/roles.ts': 'export const roles = ["baker", "clerk"];\n',
      'src/orders/order.ts': 'export interface Order {\n  id: number;\n}\n\nexport function newOrder(id: number): Order {\n  return { id };\n}\n',
      'src/orders/total.ts': 'export function total(prices: number[]): number {\n  return prices.reduce((a, b) => a + b, 0);\n}\n',
      'src/menu/bread.ts': 'export function bread(): string {\n  return "rye";\n}\n\nexport function bun(): string {\n  return "seed";\n}\n',
      'src/menu/price.ts': 'export function price(): number {\n  return 3;\n}\n\nexport function discount(): number {\n  return 0;\n}\n',
      'src/shared/log.ts': 'export function log(line: string): void {\n  void line;\n}\n',
    },
  });
  await repo.branch('feature/order-notes');
  await repo.commit(TITLE, {
    'src/auth/session.ts':
      'export function openSession(user: string, shop: string): string {\n  return user + shop;\n}\n\nexport function closeSession(): void {}\n',
    'src/orders/order.ts':
      'export interface Order {\n  id: number;\n  note: string;\n}\n\nexport function newOrder(id: number): Order {\n  return { id, note: "" };\n}\n',
    'src/orders/notes.ts':
      'export function addNote(text: string): string {\n  return text.trim();\n}\n\nexport function clearNote(): string {\n  return "";\n}\n\nexport const MAX_NOTE = 200;\n',
    'src/menu/price.ts': 'export function price(): number {\n  return 3;\n}\n',
  });
  await repo.checkout('main');
  return repo;
}

/** Runs the built CLI to completion; rejects on a non-zero exit. */
function cli(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, ...args], { env, stdio: 'ignore' });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`diffcity ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

const getJson = async <T>(url: string): Promise<T> => (await (await fetch(url)).json()) as T;

test('DC-77: the change screen HUD on a change from the real daemon', async ({ page, proof }) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ colorScheme: 'dark' });
  await titleCard(page, 'DC-77: the HUD around the city', [
    'The real daemon from dist/, in a temporary home.',
    'sample-bakery: an invented repo; feature/order-notes touches src/auth (tier 1), src/orders and src/menu.',
  ]);
  const repo = await buildSampleBakery();
  proof.onTeardown(() => repo.cleanup());
  const env = await ghStubEnv(proof.root, proof.env, []);
  await proof.startDaemon(env);
  await cli(['track', repo.dir], env);
  const base = proof.baseURL;
  const repoId = await waitFor(async () => {
    const repos = await getJson<RepoSummary[]>(`${base}/api/repos`);
    return repos.find((candidate) => candidate.name === 'sample-bakery')?.id;
  }, 60_000, 'sample-bakery in /api/repos');
  const change = await waitFor(async () => {
    const detail = await getJson<RepoDetail>(`${base}/api/repos/${String(repoId)}`);
    return detail.changes.find((candidate) => candidate.ref.endsWith('feature/order-notes') && candidate.stats !== null);
  }, 60_000, 'feature/order-notes with its first snapshot');
  const report = await getJson<Report>(`${base}/api/changes/${String(change.id)}/report`);
  const files = report.packages.flatMap((pkg) => pkg.files);

  await page.goto(`${base}/?scene-debug#/change/${String(change.id)}`);
  await waitReady(page);

  await criterion(
    page,
    '1. Top bar: counters by status and the "need your eyes" badge',
    async () => {
      const bar = page.getByTestId('hud-bar');
      const { summary } = report;
      await expect(bar.getByTestId('stat-files')).toHaveText(`${String(summary.files)}files`);
      await expect(bar.getByTestId('stat-add')).toHaveText(`${String(summary.byStatus.add)}added`);
      await expect(bar.getByTestId('stat-mod')).toHaveText(`${String(summary.byStatus.mod)}modified`);
      await expect(bar.getByTestId('stat-sig')).toHaveText(`${String(summary.byStatus.sig)}signature`);
      await expect(bar.getByTestId('stat-del')).toHaveText(`${String(summary.byStatus.del)}removed`);
      await expect(bar.getByTestId('eyes-badge')).toContainText('your eyes before merge');
      await expect(bar.getByRole('button', { name: 'Export PlantUML' })).toBeDisabled();
      await bar.getByRole('button', { name: 'Export PlantUML' }).hover();
    },
    'counters from the Report summary; Export and Approve arrive in a later version',
  );

  await criterion(
    page,
    '2. Verdict filter: other verdicts are dimmed, the chip again turns it off',
    async () => {
      const chip = page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Needs your eyes/ });
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      const dimmed = (await paintDump(page)).dimmed;
      expect(dimmed.length).toBe(files.filter((file) => file.verdict !== 'eyes').length);
      await page.waitForTimeout(HOLD_MS);
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(async () => (await paintDump(page)).dimmed).toEqual([]);
    },
    'Needs your eyes: only the tier 1 file stays lit',
  );

  await criterion(
    page,
    '3. Type filter: floors of other types dim, and buildings with no such floor',
    async () => {
      const chip = page.getByRole('group', { name: 'Filter by change type' }).getByRole('button', { name: /^Added/ });
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => Object.keys((await paintDump(page)).floors).length).toBeGreaterThan(0);
      await page.waitForTimeout(HOLD_MS);
      await page.getByRole('button', { name: 'Show everything' }).click();
      await expect.poll(async () => (await paintDump(page)).dimmed).toEqual([]);
    },
    'Added, then Show everything',
  );

  await criterion(
    page,
    '4. Tooltip on hover: verdict, file, package, counts, floor, findings',
    async () => {
      const session = await project(page, SESSION);
      await page.mouse.move(session.x, session.y, { steps: 20 });
      await waitForCityAttribute(page, 'data-hovered', SESSION);
      const tip = page.getByTestId('tooltip');
      await expect(tip.getByTestId('tip-verdict')).toHaveText('Needs your eyes');
      await expect(tip.getByTestId('tip-file')).toHaveText('session.ts');
      await expect(tip.getByTestId('tip-package')).toHaveText('src/auth');
      await expect(tip.getByTestId('tip-floor')).toContainText('floor:');
    },
    'src/auth/session.ts, tier 1',
  );

  await criterion(
    page,
    '5. Selection card: verdict, tier, file, counts and symbols with status',
    async () => {
      const notes = await project(page, NOTES);
      await page.mouse.move(notes.x, notes.y, { steps: 20 });
      await page.mouse.click(notes.x, notes.y);
      await waitForCityAttribute(page, 'data-selected', NOTES);
      const card = page.getByTestId('selection-card');
      await expect(card).toBeVisible();
      await expect(card.getByTestId('card-file')).toHaveText(NOTES);
      await expect(card.getByTestId('card-symbols').getByRole('listitem')).toHaveCount(3);
      await page.waitForTimeout(HOLD_MS);
      const session = await project(page, SESSION);
      await page.mouse.click(session.x, session.y);
      await waitForCityAttribute(page, 'data-selected', SESSION);
      await expect(card.getByTestId('card-tier')).toHaveText('tier 1');
    },
    'a file in src/orders, then the tier 1 file',
  );

  await criterion(
    page,
    '6. Live update: a commit lands while the screen is open',
    async () => {
      const before = (await stats(page)).buildings;
      await repo.checkout('feature/order-notes');
      await repo.commit('add receipts to orders', {
        'src/orders/receipt.ts': 'export function receipt(total: number): string {\n  return String(total);\n}\n\nexport function receiptLine(): string {\n  return "-";\n}\n\nexport function receiptFooter(): string {\n  return "thanks";\n}\n',
        'src/menu/bread.ts': 'export function bread(): string {\n  return "rye";\n}\n\nexport function bun(): string {\n  return "seed";\n}\n\nexport function roll(): string {\n  return "plain";\n}\n',
      });
      await repo.checkout('main');
      await expect.poll(async () => (await stats(page)).buildings, { timeout: 60_000 }).toBe(before + 1);
      await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.tweening()'), { timeout: 30_000 }).toBe(false);
      const trace = await page.evaluate<{ id: string; heights: number[] } | null>('window.diffcityScene.tweenTrace()');
      expect(trace?.id).toBe(RECEIPT);
      // The selection and the camera stayed.
      await waitForCityAttribute(page, 'data-selected', SESSION);
      await expect(page.getByTestId('hud-bar').getByTestId('stat-files')).not.toHaveText(`${String(report.summary.files)}files`);
    },
    'the new building rises, the others move and grow; selection and camera stay',
  );

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-77: all criteria hold', [
    '1. Top bar: counters by status and the "need your eyes" badge',
    '2. Verdict filter: other verdicts are dimmed, the chip again turns it off',
    '3. Type filter: floors of other types dim, and buildings with no such floor',
    '4. Tooltip on hover: verdict, file, package, counts, floor, findings',
    '5. Selection card: verdict, tier, file, counts and symbols with status',
    '6. Live update: a commit lands while the screen is open',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
