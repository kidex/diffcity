// Proof video for DC-80 (ADR-026, the night effects): the real daemon from
// dist/, in a temporary home, tracks the invented sample-bakery repo whose
// branch feature/order-notes touches files in three packages, one of them the
// tier 1 src/auth. The daemon's Report does not carry steps or findings yet, so
// the page adds a reading path and a few findings to the Report it fetches
// (page.route), and hands the scene a fake review overlay through the
// ?scene-debug hook. On screen: the critical floors pulse (tier 1 changes and
// high findings) and the tier 1 ring breathes; pins by severity and rule X
// markers on a floor and on a roof; the reading path with packets and numbered
// rings; checked rendering through a live update that does not rebuild the
// towers; reduced motion with a static glow and a halo. Recorded by
// `npm run proof -- DC-80`.

import { spawn } from 'node:child_process';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../support/acceptance.js';
import { effects, framesIn } from '../support/effects.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';
import { stats, waitReady } from '../support/scene.js';

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


function finding(id: string, source: string, severity: Finding['severity'], file: string, symbolId?: string): Finding {
  return {
    id,
    source,
    severity,
    category: source.startsWith('rule:') ? 'architecture' : 'correctness',
    file,
    line: 3,
    ...(symbolId === undefined ? {} : { symbolId }),
    title: `Finding ${id}`,
    message: `Message of ${id}`,
    state: 'open',
  };
}

/** The daemon's Report with a reading path and findings added: what the Report will carry once steps and findings are computed. */
function enrich(report: Report): Report {
  const files = report.packages.flatMap((pkg) => pkg.files);
  const byPath = (path: string) => files.find((file) => file.path === path);
  const symbolOf = (path: string, name: string): string | undefined => byPath(path)?.symbols.find((symbol) => symbol.name === name)?.id;
  const stops = [SESSION, ORDER, NOTES, PRICE].flatMap((path) => {
    const file = byPath(path);
    const symbol = file?.symbols.find((candidate) => candidate.status !== 'same') ?? file?.symbols[0];
    return file === undefined || symbol === undefined ? [] : [{ file, symbol }];
  });
  return {
    ...report,
    steps: stops.map(({ file, symbol }, i) => ({ order: i + 1, symbolId: symbol.id, fileId: file.id, why: `Step ${String(i + 1)}`, diff: [] })),
    findings: [
      ...report.findings,
      finding('proof-high-roof', 'claude', 'high', NOTES),
      finding('proof-pin-med', 'claude', 'med', SESSION),
      finding('proof-pin-low', 'semgrep', 'low', ORDER),
      finding('proof-rule-floor', 'rule:file-size', 'low', ORDER, symbolOf(ORDER, 'newOrder')),
      finding('proof-rule-roof', 'rule:layers', 'med', PRICE),
    ],
  };
}

test('DC-80: night effects on a change from the real daemon', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await titleCard(page, 'DC-80: the night effects', [
    'The real daemon from dist/, in a temporary home.',
    'sample-bakery: an invented repo; feature/order-notes touches src/auth (tier 1), src/orders and src/menu.',
    'The page adds a reading path and findings to the Report, and a fake review overlay.',
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

  await criterion(
    page,
    '1. Critical floors pulse; the tier 1 ring breathes',
    async () => {
      await expect.poll(async () => (await effects(page)).pulsing).toBeGreaterThan(0);
      const state = await effects(page);
      expect(state.pulse[SESSION]).toBeDefined();
      expect(state.pulse[NOTES]).toBeDefined();
      expect(state.continuous).toBe(true);
      expect(state.tier.ring).toBe(true);
      await page.waitForTimeout(HOLD_MS * 2);
    },
    'the tier 1 file and the high finding pulse, each on its own phase',
  );

  await criterion(
    page,
    '2. Finding pins by severity; rule violations are X markers',
    async () => {
      const { markers } = await effects(page);
      expect(markers.filter((marker) => marker.kind === 'pin').map((marker) => marker.severity).sort()).toEqual(['high', 'low', 'med']);
      expect(markers.find((marker) => marker.kind === 'x' && marker.floor !== null)?.file).toBe(ORDER);
      expect(markers.find((marker) => marker.kind === 'x' && marker.floor === null)?.file).toBe(PRICE);
      await page.waitForTimeout(HOLD_MS * 2);
    },
    'pins on roofs; an X on the floor of its symbol and one on a roof',
  );

  await criterion(
    page,
    '3. The reading path: a tube with travelling packets and numbered rings',
    async () => {
      const { path } = await effects(page);
      expect(path).toMatchObject({ stops: [1, 2, 3, 4], tube: true, animated: true, visible: true });
      expect((await stats(page)).drawCalls).toBeLessThanOrEqual(40);
      await page.waitForTimeout(HOLD_MS * 2);
    },
    'four stops, in step order; the scene stays within 40 draw calls',
  );

  await criterion(
    page,
    '4. Marks: a checked file goes quiet, a floor marked for rewrite is notched, a live update keeps the towers',
    async () => {
      await page.evaluate(`window.diffcityMarks = { files: { ${JSON.stringify(SESSION)}: 'good' }, symbols: { ${JSON.stringify(`${ORDER}#newOrder`)}: 'rewrite' } }`);
      const before = (await stats(page)).builds;
      await repo.checkout('feature/order-notes');
      await repo.commit('tidy the order note', { 'src/orders/notes.ts': 'export function addNote(text: string): string {\n  return text.trim();\n}\n\nexport function clearNote(): string {\n  return "";\n}\n\nexport const MAX_NOTE = 240;\n' });
      await repo.checkout('main');
      await expect.poll(async () => (await effects(page)).markers.some((marker) => marker.kind === 'check'), { timeout: 60_000 }).toBe(true);
      await expect.poll(() => page.evaluate<boolean>('window.diffcityScene.tweening()'), { timeout: 30_000 }).toBe(false);
      const state = await effects(page);
      expect(state.pulse[SESSION]).toBeUndefined();
      expect(state.checked[SESSION]?.length).toBeGreaterThan(0);
      expect(state.markers.some((marker) => marker.kind === 'notch' && marker.file === ORDER)).toBe(true);
      expect((await stats(page)).builds - before).toBeLessThanOrEqual(2);
      await page.waitForTimeout(HOLD_MS * 2);
    },
    'src/auth/session.ts: check mark, quiet strips, no pulse; src/orders/order.ts: a notch on newOrder',
  );

  await criterion(
    page,
    '5. Reduced motion: a static glow with a halo, no packets, no frames while idle',
    async () => {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.reload();
      await waitReady(page);
      await expect.poll(async () => (await effects(page)).pulsing).toBeGreaterThan(0);
      const state = await effects(page);
      expect(state.mode).toBe('static');
      expect(state.halos).toBe(state.pulsing);
      expect(state.path?.animated).toBe(false);
      expect(state.continuous).toBe(false);
      await expect.poll(() => framesIn(page, 1500), { timeout: 30_000 }).toBe(0);
      await page.waitForTimeout(HOLD_MS * 2);
    },
    'the same floors glow steadily; nothing renders until something changes',
  );

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-80: all criteria hold', [
    '1. Critical floors pulse; the tier 1 ring breathes',
    '2. Finding pins by severity; rule violations are X markers',
    '3. The reading path: a tube with travelling packets and numbered rings',
    '4. Marks: a checked file goes quiet, a floor marked for rewrite is notched',
    '5. Reduced motion: a static glow with a halo, no packets, no frames while idle',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
