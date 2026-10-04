// Proof video for DC-64: the real daemon from dist/, in a temporary home,
// tracks the invented sample-bakery repo. Its Repo screen toggle says "No
// closed changes" while nothing is archived; when the branch is deleted the
// daemon archives the change and the toggle reads "Show closed changes (1)"
// with no reload. Recorded by `npm run proof -- DC-64`.

import { spawn } from 'node:child_process';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';

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

test('DC-64: the Repo screen toggle counts the closed changes', async ({ page, proof }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ colorScheme: 'dark' });
  await titleCard(page, 'DC-64: the number of closed changes on the Repo screen', [
    'The real daemon from dist/, in a temporary home.',
    'sample-bakery: an invented repo with one branch, feature/rye-loaf, that is deleted during the video.',
  ]);
  const repo = await createRepo({
    name: 'sample-bakery',
    files: { 'src/menu/bread.ts': 'export function bread(): string {\n  return "rye";\n}\n' },
  });
  proof.onTeardown(() => repo.cleanup());
  await repo.branch('feature/rye-loaf');
  await repo.checkout('feature/rye-loaf');
  await repo.commit('add a rye loaf', { 'src/menu/loaf.ts': 'export const LOAF = "rye";\n' });
  await repo.checkout('main');
  const env = await ghStubEnv(proof.root, proof.env, []);
  await proof.startDaemon(env);
  await cli(['track', repo.dir], env);
  const base = proof.baseURL;
  const found = await waitFor(async () => {
    const repos = await getJson<RepoSummary[]>(`${base}/api/repos`);
    const candidate = repos.find((item) => item.name === 'sample-bakery');
    if (candidate === undefined) return undefined;
    const detail = await getJson<RepoDetail>(`${base}/api/repos/${String(candidate.id)}`);
    return detail.changes.some((change) => change.ref === 'branch:feature/rye-loaf') ? candidate : undefined;
  }, 60_000, 'sample-bakery with its branch in /api/repos');

  const toggle = page.getByTestId('archive-toggle');
  await criterion(page, '1. With nothing archived the toggle says "No closed changes" and stays enabled', async () => {
    await page.goto(`${base}/#/repo/${String(found.id)}`);
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
    await expect(toggle).toHaveText('No closed changes');
    await expect(toggle).toBeEnabled();
    await page.waitForTimeout(HOLD_MS);
  });

  await criterion(page, '2. A deleted branch is archived and the toggle counts it live', async () => {
    await repo.git('branch', '-D', 'feature/rye-loaf');
    await expect(toggle).toHaveText('Show closed changes (1)', { timeout: 60_000 });
    await page.waitForTimeout(HOLD_MS);
  });

  await criterion(page, '3. The toggle opens the closed list with that one change', async () => {
    await toggle.click();
    await expect(toggle).toHaveText('Back to open changes');
    await expect(page.getByTestId('change-row')).toHaveCount(1);
    await expect(page.getByTestId('archive-reason')).toHaveText('Branch deleted');
    await page.waitForTimeout(HOLD_MS);
  });

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-64: all criteria hold', [
    '1. With nothing archived the toggle says "No closed changes" and stays enabled',
    '2. A deleted branch is archived and the toggle counts it live',
    '3. The toggle opens the closed list with that one change',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
