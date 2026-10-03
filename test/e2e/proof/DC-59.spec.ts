// Proof video for DC-59 (ADR-026, the night data city): the real daemon from
// dist/, in a temporary home, tracks the invented sample-bakery repo whose
// branch feature/order-notes touches files in three packages, one of them the
// tier 1 src/auth. From the Repo screen the change opens as a city: a lot per
// package, a building per file, a floor per symbol, verdict tags over the
// touched buildings. The camera orbits, zooms and resets with R; a building is
// hovered, selected, and Escape clears it. Recorded by `npm run proof -- DC-59`.

import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';
import { camera, project, stats, waitReady, waitForCityAttribute } from '../support/scene.js';

const TITLE = 'add notes to orders';
const SESSION = 'src/auth/session.ts';
const NOTES = 'src/orders/notes.ts';

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

/** Slow, visible drag across the canvas from `from` by (dx, dy). */
async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 30 });
  await page.mouse.up();
}

test('DC-59: the night data city of a change from the real daemon', async ({ page, proof }) => {
  test.setTimeout(180_000);
  // The night city is the default (dark) theme; Playwright's default is light.
  await page.emulateMedia({ colorScheme: 'dark' });
  await titleCard(page, 'DC-59: the night data city in the change screen', [
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
  const touched = files.filter((file) => file.status !== 'same');

  await criterion(page, '1. Open the change from the Repo screen', async () => {
    await page.goto(`${base}/?scene-debug#/repo/${String(repoId)}`);
    const row = page.locator(`[data-testid="change-row"][data-change-id="${String(change.id)}"]`);
    await expect(row).toBeVisible();
    await row.getByTestId('change-title').hover();
    await page.waitForTimeout(600);
    await row.getByTestId('change-title').click();
    await expect(page).toHaveURL(new RegExp(`#/change/${String(change.id)}$`));
    await waitReady(page);
  });

  await criterion(
    page,
    '2. The city: a lot per package, a building per file, a floor per symbol',
    async () => {
      const scene = await stats(page);
      expect(scene.lots).toBe(report.packages.length);
      expect(scene.buildings).toBe(files.length);
      expect(scene.floors).toBeGreaterThan(scene.buildings);
    },
    `${String(report.packages.length)} packages, ${String(files.length)} files`,
  );

  await criterion(
    page,
    '3. Verdict tags over touched buildings; tier 1 outlined',
    async () => {
      await expect(page.getByTestId('roof-label')).toHaveCount(touched.length);
      const auth = report.packages.find((pkg) => pkg.path === 'src/auth');
      expect(auth?.tier1).toBe(true);
      const session = page.locator(`[data-testid="roof-label"][data-building="${SESSION}"]`);
      await expect(session).toHaveClass(/tier1/);
      await expect(session).toHaveClass(/v-eyes/);
    },
    'src/auth is a tier 1 lot: its touched file needs your eyes',
  );

  await criterion(page, '4. Orbit, zoom and R to reset', async () => {
    const home = await camera(page);
    const canvas = page.getByTestId('city-canvas');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('no canvas');
    const corner = { x: box.x + 60, y: box.y + box.height - 60 };
    await drag(page, corner, 260, -60);
    await page.waitForTimeout(500);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(500);
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.wheel(0, 160);
      await page.waitForTimeout(100);
    }
    expect(await camera(page)).not.toEqual(home);
    await page.waitForTimeout(600);
    await page.keyboard.press('r');
    await expect.poll(() => camera(page)).toEqual(home);
  });

  await criterion(page, '5. Hover and select a building, Esc clears', async () => {
    const notes = await project(page, NOTES);
    await page.mouse.move(notes.x, notes.y, { steps: 20 });
    await waitForCityAttribute(page, 'data-hovered', NOTES);
    await page.waitForTimeout(800);
    const session = await project(page, SESSION);
    await page.mouse.move(session.x, session.y, { steps: 20 });
    await waitForCityAttribute(page, 'data-hovered', SESSION);
    await page.waitForTimeout(500);
    await page.mouse.click(session.x, session.y);
    await waitForCityAttribute(page, 'data-selected', SESSION);
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await waitForCityAttribute(page, 'data-selected', '');
  });

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-59: all criteria hold', [
    '1. Open the change from the Repo screen',
    '2. The city: a lot per package, a building per file, a floor per symbol',
    '3. Verdict tags over touched buildings; tier 1 outlined',
    '4. Orbit, zoom and R to reset',
    '5. Hover and select a building, Esc clears',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
