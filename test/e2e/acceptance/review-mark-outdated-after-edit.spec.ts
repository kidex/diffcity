// e2e/review/mark-outdated-after-edit-real-daemon (ADR-028): the real daemon
// from dist/, in a temporary DIFFCITY_HOME, on the invented `sample-bakery`
// repo with uncommitted work (a Draft). A file is marked Checked through the UI
// and the mark survives a reload. Editing that file in the working tree makes
// the daemon take a new snapshot: the mark reads "changed since you checked
// it" and the progress counts the file as unchecked again.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import { CLI_DIST, stopDaemonIn, waitFor } from '../../helpers/daemon.js';
import { registerHome } from '../../helpers/daemons.js';
import { createRepo } from '../../helpers/repo.js';
import { card, cardButton } from '../support/review.js';
import { project, selectedFloor, waitForCityAttribute, waitReady } from '../support/scene.js';

const TOTAL = 'src/auth/session.ts';
const PRICE = 'src/auth/roles.ts';
const HINT = 'changed since you checked it';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, ...args], { env, stdio: 'ignore' });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`diffcity ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

/** `waitFor` that treats a refused connection (the daemon is not up yet) as not ready. */
const until = <T>(check: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> =>
  waitFor(() => check().catch(() => undefined), timeoutMs, what);

/** The part of `GET /review` this spec reads. */
interface ReviewState {
  snapshotId: number;
  marks: { targetKind: string; targetId: string; mark: string; state: string }[];
}

const getJson = async <T>(url: string): Promise<T> => (await (await fetch(url)).json()) as T;

test('review/mark-outdated-after-edit-real-daemon', async ({ page }) => {
  test.setTimeout(240_000);
  const repo = await createRepo({
    name: 'sample-bakery',
    files: {
      [TOTAL]: 'export function openSession(user: string): string {\n  return user;\n}\n',
      [PRICE]: 'export const roles = ["baker", "clerk"];\n',
    },
  });
  // Uncommitted work on main: a Draft touching two files.
  await repo.write({
    [TOTAL]: 'export function openSession(user: string, shop: string): string {\n  return user + shop;\n}\n',
    [PRICE]: 'export const roles = ["baker", "clerk", "owner"];\n',
  });
  const root = await mkdtemp(join(tmpdir(), 'dc-e2e-rv-'));
  const home = join(root, 'home');
  registerHome(home);
  const user = join(root, 'user');
  await mkdir(user);
  const env = { ...process.env, DIFFCITY_HOME: home, HOME: user };
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  let daemon: ChildProcess | null = null;

  try {
    daemon = spawn(process.execPath, [CLI_DIST, 'up', '--foreground', '--no-open', '--port', String(port)], { env, stdio: 'ignore' });
    await until(async () => ((await fetch(`${base}/api/health`)).ok ? true : undefined), 60_000, 'the daemon');
    await cli(['track', repo.dir], env);
    const repoId = await until(async () => (await getJson<RepoSummary[]>(`${base}/api/repos`)).find((r) => r.name === 'sample-bakery')?.id, 60_000, 'the repo');
    const change = await until(
      async () => (await getJson<RepoDetail>(`${base}/api/repos/${String(repoId)}`)).changes.find((c) => c.kind === 'draft' && c.stats !== null),
      60_000,
      'the draft with its first snapshot',
    );
    const reviewUrl = `${base}/api/changes/${String(change.id)}/review`;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(`${base}/?scene-debug#/change/${String(change.id)}`);
    await waitReady(page);
    const attention = page.getByTestId('progress-attention');
    await expect(attention).toHaveText(/^0 of \d+ files that need your eyes checked$/);
    const total = Number(/of (\d+)/.exec((await attention.textContent()) ?? '')?.[1]);
    expect(total).toBeGreaterThan(1);
    const unchecked = `0 of ${String(total)} files that need your eyes checked`;
    const one = `1 of ${String(total)} files that need your eyes checked`;

    const pick = async (file: string): Promise<void> => {
      if (await card(page).isVisible()) {
        await page.keyboard.press('Escape');
        await waitForCityAttribute(page, 'data-selected', '');
      }
      const point = await project(page, file);
      await page.mouse.move(point.x, point.y, { steps: 10 });
      await page.mouse.click(point.x, point.y);
      await waitForCityAttribute(page, 'data-selected', file);
      // A click lands on a floor, and the floor is the default target: ask for the file.
      await card(page).getByTestId('mark-scope-file').click();
    };

    // Mark the file Checked through the UI.
    await pick(TOTAL);
    expect(await selectedFloor(page)).not.toBeNull();
    await page.keyboard.press('c');
    await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
    await expect(attention).toHaveText(one);

    // It is stored by the daemon and survives a reload.
    await expect.poll(async () => (await getJson<ReviewState>(reviewUrl)).marks.map((m) => `${m.targetKind}:${m.targetId}:${m.mark}:${m.state}`)).toEqual([`file:${TOTAL}:checked:current`]);
    await page.reload();
    await waitReady(page);
    await expect(attention).toHaveText(one);
    await pick(TOTAL);
    await expect(cardButton(page, 'checked')).toHaveAttribute('aria-pressed', 'true');
    await expect(card(page).getByTestId('mark-outdated')).toHaveCount(0);

    // Edit the file in the working tree: the daemon recomputes the Draft's snapshot (same head, so the row is replaced under the same id) and the mark goes outdated.
    await repo.write({ [TOTAL]: 'export function openSession(user: string, shop: string, role: string): string {\n  return user + shop + role;\n}\n' });
    await expect.poll(async () => (await getJson<ReviewState>(reviewUrl)).marks[0]?.state, { timeout: 60_000 }).toBe('outdated');

    // The open page follows the daemon (SSE), without a reload.
    await expect(attention).toHaveText(unchecked, { timeout: 30_000 });
    await expect(page.getByTestId('progress-outdated')).toHaveText('1 changed since you checked it');
    await expect(card(page).getByTestId('mark-outdated')).toHaveText(HINT);
    await expect(cardButton(page, 'checked')).toHaveAttribute('aria-pressed', 'false');

    // A fresh load says the same.
    await page.reload();
    await waitReady(page);
    await expect(attention).toHaveText(unchecked);
    await pick(TOTAL);
    await expect(card(page).getByTestId('mark-outdated')).toHaveText(HINT);
  } finally {
    if (daemon !== null && daemon.exitCode === null) {
      const exited = new Promise((resolve) => daemon?.once('exit', resolve));
      daemon.kill('SIGTERM');
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => { resolve('timeout'); }, 5_000));
      if ((await Promise.race([exited, timeout])) === 'timeout') daemon.kill('SIGKILL');
    }
    await stopDaemonIn(home);
    await rm(root, { recursive: true, force: true });
    await repo.cleanup();
  }
});
