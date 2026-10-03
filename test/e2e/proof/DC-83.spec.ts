// Proof video for DC-83 (ADR-027, the full diff in the file view): the real
// daemon from dist/, in a temporary home, tracks the invented sample-bakery
// repo whose branch feature/order-notes changes src/orders/order.ts at the top
// and at the bottom, with a long unchanged stretch between. On screen: a click
// on a floor of that building opens the daemon's own diff (line numbers, +/−
// rows, tree-sitter highlighting) at the symbol; N and Shift+N walk the hunks
// with a counter; a fold of unchanged lines opens in place; the pointer on a
// symbol's lines lights its floor; and a click and a Shift+click on line
// numbers keep a range. Recorded by `npm run proof -- DC-83`.

import { spawn } from 'node:child_process';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';
import { setScroll } from '../support/fileview.js';
import { camera, hoveredFloor, project, selectedFloor, waitForCityAttribute, waitReady } from '../support/scene.js';

const TITLE = 'add notes to orders';
const ORDER = 'src/orders/order.ts';
const SESSION = 'src/auth/session.ts';

/** order.ts: a type at the top, a long unchanged helper, `closeOrder` at the bottom. */
function orderFile(changed: boolean): string {
  const lines: string[] = [
    'export interface Order {',
    '  id: number;',
    ...(changed ? ['  note: string;'] : []),
    '}',
    '',
  ];
  lines.push('export function describeOrder(order: Order): string {', '  const parts: string[] = [];');
  for (let n = 1; n <= 24; n++) lines.push(`  parts.push("part ${String(n).padStart(2, '0')}: " + String(order.id * ${String(n)}));`);
  lines.push('  return parts.join(", ");', '}', '');
  lines.push('export function closeOrder(order: Order): boolean {', changed ? '  return order.id > 0 && order.note.length < 200;' : '  return order.id > 0;', '}', '');
  return lines.join('\n');
}

/** sample-bakery on main, with feature/order-notes one commit ahead. */
async function buildSampleBakery(): Promise<Awaited<ReturnType<typeof createRepo>>> {
  const repo = await createRepo({
    name: 'sample-bakery',
    files: {
      'src/auth/session.ts': 'export function openSession(user: string): string {\n  return user;\n}\n',
      'src/orders/order.ts': orderFile(false),
      'src/menu/bread.ts': 'export function bread(): string {\n  return "rye";\n}\n',
    },
  });
  await repo.branch('feature/order-notes');
  await repo.commit(TITLE, {
    'src/auth/session.ts': 'export function openSession(user: string, shop: string): string {\n  return user + shop;\n}\n',
    'src/orders/order.ts': orderFile(true),
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

test('DC-83: the full diff in the file view, from the real daemon', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await titleCard(page, 'DC-83: the full diff in the file view', [
    'The real daemon from dist/, in a temporary home.',
    'sample-bakery: an invented repo; feature/order-notes changes src/orders/order.ts at the top and at the bottom.',
    'The diff, its highlighting and its hunks are the daemon’s; the page only draws them.',
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
  const symbol = (name: string): string => {
    const found = report.packages.flatMap((pkg) => pkg.files).find((file) => file.id === ORDER)?.symbols.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no symbol ${name} in ${ORDER}`);
    return found.id;
  };
  const CLOSE_ORDER = symbol('closeOrder');

  await page.goto(`${base}/?scene-debug#/change/${String(change.id)}`);
  await waitReady(page);
  // The intro move of the camera is over before anything is clicked.
  await expect.poll(async () => {
    const before = JSON.stringify(await camera(page));
    await page.waitForTimeout(400);
    return before === JSON.stringify(await camera(page));
  }, { timeout: 30_000 }).toBe(true);
  const view = page.getByTestId('diff-view');
  const row = (index: number) => page.locator(`[data-row="${String(index)}"]`);
  const counter = page.getByTestId('hunk-counter');
  const changedLast = page.getByTestId('diff-text').filter({ hasText: 'order.note.length < 200' });

  await criterion(
    page,
    '1. A click on a floor opens the full diff, at that symbol',
    async () => {
      const floor = await project(page, ORDER, CLOSE_ORDER);
      await page.mouse.move(floor.x, floor.y, { steps: 20 });
      await page.mouse.click(floor.x, floor.y);
      await waitForCityAttribute(page, 'data-selected', ORDER);
      await expect(view).toHaveAttribute('data-state', 'text', { timeout: 30_000 });
      expect(await selectedFloor(page)).toBe(CLOSE_ORDER);
      await expect(changedLast).toBeVisible();
      await expect(page.locator('[data-kind="add"]').first()).toBeVisible();
      await expect(page.locator('[data-kind="del"]').first()).toBeVisible();
      await expect(view.locator('.hl-kw').first()).toBeVisible();
      await expect(page.locator('.dl.focus').first()).toBeVisible();
    },
    'old and new line numbers, +/− rows, tree-sitter highlighting; the symbol\u2019s lines are marked',
  );

  await criterion(
    page,
    '2. N and Shift+N walk the hunks, with a counter',
    async () => {
      await expect(counter).toHaveText('2 / 2');
      await page.keyboard.press('Shift+N');
      await expect(counter).toHaveText('1 / 2');
      await expect(page.getByTestId('diff-text').filter({ hasText: 'note: string;' })).toBeVisible();
      await page.waitForTimeout(HOLD_MS / 2);
      await page.keyboard.press('n');
      await expect(counter).toHaveText('2 / 2');
      await expect(changedLast).toBeVisible();
      await page.waitForTimeout(HOLD_MS / 2);
      await page.keyboard.press('Shift+N');
      await expect(counter).toHaveText('1 / 2');
    },
    'the hunk at the bottom, the one at the top, and back',
  );

  await criterion(
    page,
    '3. A fold of unchanged lines opens in place',
    async () => {
      const fold = page.getByTestId('diff-fold');
      await expect(fold).toHaveCount(1);
      await expect(fold).toContainText('unchanged lines');
      await expect(fold).toBeVisible();
      await fold.click();
      await expect(fold).toHaveCount(0);
      await expect(page.getByTestId('diff-text').filter({ hasText: 'part 12' })).toBeVisible();
      await expect(page.getByTestId('diff-text').filter({ hasText: 'note: string;' })).toBeVisible();
    },
    'collapsed by default as "N unchanged lines"; the rows above stay where they are',
  );

  await criterion(
    page,
    '4. The pointer on a symbol\u2019s lines lights its floor',
    async () => {
      await page.keyboard.press('n');
      await expect(counter).toHaveText('2 / 2');
      const lines = page.locator(`[data-symbol="${CLOSE_ORDER}"]`).first();
      await lines.hover();
      await expect.poll(() => hoveredFloor(page)).toBe(CLOSE_ORDER);
      await expect(page.locator('.dl.hot').first()).toBeVisible();
      await page.waitForTimeout(HOLD_MS / 2);
      await page.mouse.move(5, 5);
      await expect.poll(() => hoveredFloor(page)).toBeNull();
    },
    'the floor of closeOrder in the city lights up with the hover',
  );

  await criterion(
    page,
    '5. A click on a line number, a Shift+click extends the range',
    async () => {
      await setScroll(page, 0);
      await row(2).getByTestId('diff-new').click();
      await expect(view).toHaveAttribute('data-range', 'new 3');
      await row(5).getByTestId('diff-new').click({ modifiers: ['Shift'] });
      await expect(view).toHaveAttribute('data-range', 'new 3-6');
    },
    'the range is kept for the review marks',
  );

  await criterion(
    page,
    '6. Another file, another diff',
    async () => {
      const session = await project(page, SESSION);
      await page.mouse.move(session.x, session.y, { steps: 20 });
      await page.mouse.click(session.x, session.y);
      await waitForCityAttribute(page, 'data-selected', SESSION);
      await expect(view).toHaveAttribute('data-state', 'text', { timeout: 30_000 });
      await expect(counter).toHaveText('1 / 1');
    },
    'the request for the old file is dropped; the new one loads',
  );

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-83: all criteria hold', [
    '1. A click on a floor opens the full diff, at that symbol',
    '2. N and Shift+N walk the hunks, with a counter',
    '3. A fold of unchanged lines opens in place',
    '4. The pointer on a symbol’s lines lights its floor',
    '5. A click on a line number, a Shift+click extends the range',
    '6. Another file, another diff',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
