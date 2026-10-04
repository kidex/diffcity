// Proof video for DC-89 (accessible change screen): the real daemon from
// dist/, in a temporary home, tracks the invented sample-bakery repo whose
// branch feature/order-notes touches files in three packages, one of them the
// tier 1 src/auth. First without WebGL (the page hides it): the touched files
// listed by package with verdict and status tags, a click opening the file
// view with the diff from the daemon, a file marked with C and the progress in
// the top bar. Then with the city, keyboard only: ] and [ selecting buildings
// (clamped at the ends) with the selection announced in the live region, Tab
// through the filter chips and the panel tabs with the focus ring, and Enter
// to toggle a chip and to open a tab. Recorded by `npm run proof -- DC-89`.

import { spawn } from 'node:child_process';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';
import { selected, waitReady } from '../support/scene.js';

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


/** The page hides WebGL while this flag is in localStorage: the same page, with and without the city. */
const NO_WEBGL_FLAG = 'diffcity-proof-no-webgl';

const PAUSE = 700;

test('DC-89: the change screen without WebGL and with the keyboard alone', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await page.addInitScript(`{
    if (localStorage.getItem('${NO_WEBGL_FLAG}') === '1') {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
        return /webgl/i.test(kind) ? null : getContext.call(this, kind, ...rest);
      };
    }
  }`);
  await titleCard(page, 'DC-89: accessible change screen', [
    'The real daemon from dist/, in a temporary home.',
    'sample-bakery: an invented repo; feature/order-notes touches src/auth (tier 1), src/orders and src/menu.',
    'First without WebGL, then with the city and the keyboard alone.',
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
  const url = `${base}/?scene-debug#/change/${String(change.id)}`;

  // The page starts with WebGL hidden.
  await page.goto(`${base}/`);
  await page.evaluate(`localStorage.setItem('${NO_WEBGL_FLAG}', '1')`);
  await page.goto(url);
  await page.reload();

  const fileView = page.getByTestId('file-view');
  await criterion(
    page,
    '1. Without WebGL the touched files are listed by package, with verdict and status',
    async () => {
      await expect(page.getByTestId('no-webgl-note')).toHaveText('3D view needs WebGL');
      await expect(page.getByTestId('city')).toHaveCount(0);
      await expect(page.getByTestId('touched-package').first()).toBeVisible();
      await expect(page.locator(`[data-testid="touched-file"][data-path="${SESSION}"]`).getByTestId('file-verdict')).toBeVisible();
      await expect(page.locator(`[data-testid="touched-file"][data-path="${SESSION}"]`).getByText('tier 1')).toBeVisible();
      await expect(page.getByTestId('reading-panel')).toBeVisible();
    },
    'grouped by package; the reading panel is beside the list',
  );

  await criterion(
    page,
    '2. A click opens the file view with the full diff from the daemon',
    async () => {
      await page.locator(`[data-testid="touched-file"][data-path="${NOTES}"]`).getByRole('button', { name: NOTES }).click();
      await expect(fileView).toBeVisible();
      await expect(page.getByTestId('diff-view')).toHaveAttribute('data-state', 'text', { timeout: 30_000 });
      await expect(page.getByTestId('diff-row').first()).toBeVisible();
    },
    'src/orders/notes.ts: the rows, the hunks and the mark controls, with no city',
  );

  await criterion(
    page,
    '3. C marks the file; the progress in the top bar follows',
    async () => {
      await page.keyboard.press('c');
      await expect(fileView.getByTestId('mark-current')).toHaveText('Checked');
      await expect(page.getByTestId('progress')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(fileView).toBeHidden();
      await page.keyboard.press(']');
      await expect(page.locator('[data-testid="touched-file"].on')).toHaveCount(1);
    },
    'Esc returns to the tabs; ] moves the list to the next touched file',
  );

  // With the city: the same page, WebGL back.
  await page.evaluate(`localStorage.removeItem('${NO_WEBGL_FLAG}')`);
  await page.goto(url);
  await page.reload();
  await waitReady(page);
  await expect.poll(async () => page.evaluate<boolean>('window.diffcityScene.ready')).toBe(true);
  const live = page.getByTestId('selection-live');

  await criterion(
    page,
    '4. The canvas has a name for screen readers',
    async () => {
      const canvas = page.getByTestId('city-canvas');
      await expect(canvas).toHaveAttribute('role', 'img');
      await expect(canvas).toHaveAttribute('aria-label', /^\d+ files, \d+ (needs|need) your eyes, /);
    },
    'built from the Report summary: files, files that need your eyes, signature changes',
  );

  await criterion(
    page,
    '5. ] and [ select buildings in the Report’s order, and stop at the ends',
    async () => {
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press(']');
        await page.waitForTimeout(PAUSE);
      }
      const last = await selected(page);
      expect(last).not.toBeNull();
      await expect(live).toHaveText(/^Selected .+, .+/);
      await page.keyboard.press(']');
      expect(await selected(page)).toBe(last);
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('[');
        await page.waitForTimeout(PAUSE);
      }
      await expect(live).toContainText('Selected ');
    },
    'the live region says "Selected <path>, <verdict>, tier 1" for each',
  );

  await criterion(
    page,
    '6. Tab reaches the filter chips and the panel tabs, with a visible focus ring',
    async () => {
      await page.keyboard.press('Escape');
      await page.getByTestId('review-summary').focus();
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(PAUSE);
      }
      await page.keyboard.press('Enter');
      await expect(page.locator('.hud .chips button[aria-pressed="true"]')).toHaveCount(1);
      await page.waitForTimeout(HOLD_MS / 2);
      await page.keyboard.press('Enter');
      await expect(page.locator('.hud .chips button[aria-pressed="true"]')).toHaveCount(0);
      await page.getByTestId('filter-clear').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.waitForTimeout(PAUSE);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('tab-findings')).toHaveAttribute('aria-pressed', 'true');
    },
    'Tab, Enter on a chip (aria-pressed follows), Tab on to the tabs, Enter on Findings',
  );

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-89: all criteria hold', [
    '1. No WebGL: the touched files by package with verdict and status',
    '2. A click opens the file view with the full diff',
    '3. C marks the file; Esc returns to the tabs',
    '4. The canvas has a summary name',
    '5. ] and [ select buildings; the selection is announced',
    '6. Tab reaches chips and tabs with a visible focus ring',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
