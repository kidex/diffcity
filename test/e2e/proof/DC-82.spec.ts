// Proof video for DC-82 (ADR-026, the reading panel): the real daemon from
// dist/, in a temporary home, tracks the invented sample-bakery repo whose
// branch feature/order-notes touches files in three packages, one of them the
// tier 1 src/auth. The daemon's Report does not carry steps or findings yet, so
// the page adds a reading path, findings and a spec verdict to the Report it
// fetches (page.route). On screen: the panel with its four tabs and counters;
// a stop card with its rail, tags, why, inline diff and finding; J and K
// walking the stops while the city follows; a click on a building opening the
// file view; Esc returning to the tabs where they were. Recorded by
// `npm run proof -- DC-82`.

import { spawn } from 'node:child_process';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { DiffLine, Finding, Report } from '../../../src/core/report/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';
import { tabScroll } from '../support/panel.js';
import { project, selected, selectedFloor, waitForCityAttribute, waitReady } from '../support/scene.js';

const TITLE = 'add notes to orders';
const SESSION = 'src/auth/session.ts';
const NOTES = 'src/orders/notes.ts';
const ORDER = 'src/orders/order.ts';
const PRICE = 'src/menu/price.ts';

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


const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });

function finding(id: string, source: string, severity: Finding['severity'], file: string, title: string, symbolId?: string): Finding {
  return {
    id,
    source,
    severity,
    category: 'correctness',
    file,
    line: 3,
    ...(symbolId === undefined ? {} : { symbolId }),
    title,
    message: `${title}; seen in ${file}.`,
    state: 'open',
  };
}

/** The daemon's Report with a reading path, findings and a spec verdict added: what the Report will carry once they are computed. */
function enrich(report: Report): Report {
  const files = report.packages.flatMap((pkg) => pkg.files);
  const byPath = (path: string) => files.find((file) => file.path === path);
  const symbolOf = (path: string, name: string): string => byPath(path)?.symbols.find((symbol) => symbol.name === name)?.id ?? `${path}#${name}`;
  const price = byPath(PRICE);
  if (price !== undefined) price.inSpec = false;
  return {
    ...report,
    steps: [
      { order: 1, fileId: SESSION, symbolId: symbolOf(SESSION, 'openSession'), why: 'The session now carries the shop it was opened for.', diff: [line('del', 'export function openSession(user: string): string {'), line('add', 'export function openSession(user: string, shop: string): string {'), line('ctx', '  return user + shop;')] },
      { order: 2, fileId: ORDER, symbolId: symbolOf(ORDER, 'newOrder'), why: 'New orders start with an empty note.', diff: [line('ctx', 'export function newOrder(id: number): Order {'), line('del', '  return { id };'), line('add', '  return { id, note: "" };')] },
      { order: 3, fileId: NOTES, symbolId: symbolOf(NOTES, 'addNote'), why: 'The new module that stores a note on an order.', diff: [line('add', 'export function addNote(text: string): string {'), line('add', '  return text.trim();'), line('add', '}')] },
      { order: 4, fileId: PRICE, symbolId: symbolOf(PRICE, 'price'), why: 'The discount is gone from the price list.', diff: [] },
    ],
    findings: [
      ...report.findings,
      finding('proof-change', 'claude', 'med', '', 'The change touches menu prices too'),
      finding('proof-session', 'claude', 'high', SESSION, 'The shop is not checked against the user', symbolOf(SESSION, 'openSession')),
      finding('proof-notes', 'semgrep', 'low', NOTES, 'The note is not length limited', symbolOf(NOTES, 'addNote')),
    ],
  };
}

test('DC-82: the reading panel on a change from the real daemon', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await titleCard(page, 'DC-82: the reading panel', [
    'The real daemon from dist/, in a temporary home.',
    'sample-bakery: an invented repo; feature/order-notes touches src/auth (tier 1), src/orders and src/menu.',
    'The page adds a reading path, findings and a spec verdict to the Report.',
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

  await page.route('**/api/changes/*/report', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: enrich((await response.json()) as Report) });
  });
  await page.goto(`${base}/?scene-debug#/change/${String(change.id)}`);
  await waitReady(page);
  const panel = page.getByTestId('reading-panel');

  await criterion(
    page,
    '1. The panel: "Reading path", four tabs with counters',
    async () => {
      await expect(panel.getByRole('heading', { name: 'Reading path' })).toBeVisible();
      await expect(page.getByTestId('tab-order')).toHaveText('Execution order4');
      await expect(page.getByTestId('tab-findings')).toHaveText('Findings3');
      await expect(page.getByTestId('tab-outside')).toHaveText('Outside the spec1');
      for (const id of ['findings', 'outside', 'symbols', 'order']) {
        await page.getByTestId(`tab-${id}`).click();
        await page.waitForTimeout(HOLD_MS / 2);
      }
    },
    'Execution order, Findings, Outside the spec, Symbols; Session is hidden',
  );

  await criterion(
    page,
    '2. A stop card: rail, tags, why, inline diff, finding with its source',
    async () => {
      const card = page.getByTestId('stop-card').first();
      await expect(card.getByTestId('stop-symbol')).toHaveText('openSession');
      await expect(card.getByTestId('stop-verdict')).toHaveText('Needs your eyes');
      await expect(card.getByTestId('step-diff')).toBeVisible();
      await expect(card.getByTestId('finding-source')).toHaveText('claude');
      await card.hover();
      await expect.poll(async () => (await page.getByTestId('city').getAttribute('data-hovered')) ?? '').toBe(SESSION);
    },
    'hovering the card lights its building in the city',
  );

  await criterion(
    page,
    '3. J and K walk the stops; the city follows',
    async () => {
      await page.mouse.move(5, 5);
      for (const [key, file] of [['j', SESSION], ['j', ORDER], ['j', NOTES], ['k', ORDER]] as const) {
        await page.keyboard.press(key);
        await expect.poll(() => selected(page)).toBe(file);
        await expect(page.locator('.step.on')).toHaveCount(1);
        await page.waitForTimeout(HOLD_MS / 2);
      }
    },
    'the selection, the floor and the marked card move together',
  );

  let scrolled = 0;
  await criterion(
    page,
    '4. A click on a building opens the file view',
    async () => {
      scrolled = await tabScroll(page);
      const notes = await project(page, NOTES);
      await page.mouse.move(notes.x, notes.y, { steps: 20 });
      await page.mouse.click(notes.x, notes.y);
      await waitForCityAttribute(page, 'data-selected', NOTES);
      const view = page.getByTestId('file-view');
      await expect(view.getByTestId('file-view-file')).toHaveText(NOTES);
      await expect(view.getByTestId('file-view-package')).toHaveText('src/orders');
      await expect(view.getByTestId('stop-card')).toHaveCount(1);
      await expect(view.getByTestId('file-diff')).toBeVisible();
      expect(await selectedFloor(page)).not.toBeNull();
    },
    'file, package, verdict, counts, the file stops and the diff excerpts',
  );

  await criterion(
    page,
    '5. Esc returns to the tabs',
    async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('file-view')).toBeHidden();
      await expect(page.getByTestId('tab-order')).toBeVisible();
      await waitForCityAttribute(page, 'data-selected', '');
      expect(await tabScroll(page)).toBe(scrolled);
    },
    'the tabs are back, on the tab and at the scroll position they had',
  );

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-82: all criteria hold', [
    '1. The panel: "Reading path", four tabs with counters',
    '2. A stop card: rail, tags, why, inline diff, finding with its source',
    '3. J and K walk the stops; the city follows',
    '4. A click on a building opens the file view',
    '5. Esc returns to the tabs',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
