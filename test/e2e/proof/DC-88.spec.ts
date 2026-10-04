// Proof video for DC-88 (ADR-028, review marks): the real daemon from dist/, in
// a temporary home, tracks the invented sample-bakery repo whose branch
// feature/order-notes touches files in three packages, one of them the tier 1
// src/auth. On screen, through the real review API: a file marked Checked, a
// floor marked Looks good, a floor marked Needs rewrite with a note (an empty
// note is refused first, and the line range comes from the diff selection), the
// progress in the top bar following every mark, the change moving to "In
// review" on the first mark, "Hide checked", and the review summary with the
// general note and Copy. Recorded by `npm run proof -- DC-88`.

import { spawn } from 'node:child_process';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';
import { camera, project, selectedFloor, waitForCityAttribute, waitReady } from '../support/scene.js';

const TITLE = 'add notes to orders';
const SESSION = 'src/auth/session.ts';
const ORDER = 'src/orders/order.ts';
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

test('DC-88: review marks on a change from the real daemon', async ({ page, proof, context }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await titleCard(page, 'DC-88: review marks', [
    'The real daemon from dist/, in a temporary home.',
    'sample-bakery: an invented repo; feature/order-notes touches src/auth (tier 1), src/orders and src/menu.',
    'Every mark goes through the daemon’s review API; progress and the summary are the daemon’s.',
  ]);
  const repo = await buildSampleBakery();
  proof.onTeardown(() => repo.cleanup());
  const env = await ghStubEnv(proof.root, proof.env, []);
  await proof.startDaemon(env);
  await cli(['track', repo.dir], env);
  const base = proof.baseURL;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const repoId = await waitFor(async () => {
    const repos = await getJson<RepoSummary[]>(`${base}/api/repos`);
    return repos.find((candidate) => candidate.name === 'sample-bakery')?.id;
  }, 60_000, 'sample-bakery in /api/repos');
  const change = await waitFor(async () => {
    const detail = await getJson<RepoDetail>(`${base}/api/repos/${String(repoId)}`);
    return detail.changes.find((candidate) => candidate.ref.endsWith('feature/order-notes') && candidate.stats !== null);
  }, 60_000, 'feature/order-notes with its first snapshot');

  await page.goto(`${base}/?scene-debug#/change/${String(change.id)}`);
  await waitReady(page);
  // The intro move of the camera is over before anything is clicked.
  await expect.poll(async () => {
    const before = JSON.stringify(await camera(page));
    await page.waitForTimeout(400);
    return before === JSON.stringify(await camera(page));
  }, { timeout: 30_000 }).toBe(true);

  const card = page.getByTestId('selection-card');
  const attention = page.getByTestId('progress-attention');
  const pick = async (file: string): Promise<void> => {
    // The card sits over the corner of the city: clear the selection before the next click.
    if (await card.isVisible()) {
      await page.keyboard.press('Escape');
      await waitForCityAttribute(page, 'data-selected', '');
    }
    const point = await project(page, file);
    await page.mouse.move(point.x, point.y, { steps: 15 });
    await page.mouse.click(point.x, point.y);
    await waitForCityAttribute(page, 'data-selected', file);
  };

  await criterion(
    page,
    '1. The top bar says how far the review is; nothing is marked yet',
    async () => {
      await expect(attention).toHaveText(/^0 of \d+ files that need your eyes checked$/);
      await expect(page.getByTestId('progress-touched')).toContainText('touched files checked');
      await expect(page.locator('.tag.review')).toHaveText('Unreviewed');
    },
    'the numbers come from the daemon',
  );

  await criterion(
    page,
    '2. C marks a whole file Checked; the change moves to In review',
    async () => {
      await pick(SESSION);
      await card.getByTestId('mark-scope-file').click();
      await expect(card.getByTestId('mark-target')).toHaveText('Mark this file');
      await page.keyboard.press('c');
      await expect(card.getByTestId('mark-current')).toHaveText('Checked');
      await expect(attention).toHaveText(/^1 of \d+ files that need your eyes checked$|^Everything that needs your eyes is checked$/);
      await expect(page.locator('.tag.review')).toHaveText('In review', { timeout: 30_000 });
    },
    'src/auth/session.ts: quiet strips, a check mark on the roof, no pulse',
  );

  await criterion(
    page,
    '3. G marks a floor Looks good',
    async () => {
      await pick(ORDER);
      const floor = await selectedFloor(page);
      expect(floor).not.toBeNull();
      await expect(card.getByTestId('mark-target')).toContainText('Mark floor ');
      await page.keyboard.press('g');
      await expect(card.getByTestId('mark-current')).toHaveText('Looks good');
      await expect(card.getByTestId('mark-scope-floor')).toHaveAttribute('aria-pressed', 'true');
    },
    'one floor of src/orders/order.ts; the rest of the file is still unmarked',
  );

  await criterion(
    page,
    '4. W needs a note: an empty one is refused, a range comes from the diff',
    async () => {
      await pick(NOTES);
      const view = page.getByTestId('diff-view');
      await expect(view).toHaveAttribute('data-state', 'text', { timeout: 30_000 });
      // Pick the first added line of the diff: the range the dialog starts from.
      const added = page.locator('[data-kind="add"]').first();
      await added.getByTestId('diff-new').click();
      await expect(view).toHaveAttribute('data-range', /^new \d+/);
      await page.getByTestId('file-view').getByTestId('mark-rewrite').click();
      const dialog = page.getByTestId('rewrite-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('rewrite-lines-start')).not.toHaveValue('');
      await dialog.getByTestId('rewrite-save').click();
      await expect(dialog.getByTestId('rewrite-note-error')).toBeVisible();
      await page.waitForTimeout(HOLD_MS / 2);
      await dialog.getByTestId('rewrite-note').fill('Trim the text before the length check, and reject an empty note.');
      await dialog.getByTestId('rewrite-save').click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('file-view').getByTestId('mark-current')).toHaveText('Needs rewrite');
      await expect(page.getByTestId('file-view').getByTestId('mark-lines')).toContainText('new line');
      await expect(page.getByTestId('progress-rewrite')).toHaveText('1 to rewrite');
    },
    'src/orders/notes.ts: a notch on the floor, a plate on the roof, the lines and the note in the file view',
  );

  await criterion(
    page,
    '5. Hide checked hides the marked files and floors',
    async () => {
      await page.keyboard.press('Escape');
      await waitForCityAttribute(page, 'data-selected', '');
      await page.getByTestId('filter-hide-checked').click();
      await expect(page.getByTestId('filter-hide-checked')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('city')).toHaveAttribute('data-filters', /hide-checked/);
      await expect.poll(async () => (await page.evaluate<{ dimmed: string[] }>('window.diffcityScene.paint()')).dimmed).toContain(SESSION);
      await page.waitForTimeout(HOLD_MS);
      await page.getByTestId('filter-hide-checked').click();
    },
    'the checked file fades out; the rest of the city stays',
  );

  await criterion(
    page,
    '6. The review summary: the daemon’s markdown, a general note, Copy',
    async () => {
      await page.getByTestId('review-summary').click();
      const dialog = page.getByTestId('summary-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('summary-text')).toContainText('## Needs rewrite (1)');
      await expect(dialog.getByTestId('summary-text')).toContainText(NOTES);
      await dialog.getByTestId('summary-note').fill('Fix the notes file before anything else.');
      await dialog.getByTestId('summary-note-save').click();
      await expect(dialog.getByTestId('summary-text')).toContainText('Fix the notes file before anything else.');
      await dialog.getByTestId('summary-copy').click();
      await expect(dialog.getByTestId('summary-copy-status')).toHaveText('Copied');
      await expect(dialog.getByTestId('summary-phase')).toHaveText('Sending it to the agent arrives in phase 4');
      await page.waitForTimeout(HOLD_MS);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    },
    'plain text, never rendered; sending it to the agent comes in phase 4',
  );

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-88: all criteria hold', [
    '1. The top bar says how far the review is',
    '2. C marks a whole file Checked; the change moves to In review',
    '3. G marks a floor Looks good',
    '4. W needs a note; the range comes from the diff',
    '5. Hide checked hides the marked files and floors',
    '6. The review summary: the daemon’s markdown, a general note, Copy',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
