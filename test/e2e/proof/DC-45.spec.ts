// Proof video for DC-45: `diffcity start`, run by executing the built CLI the
// way a shell runs a globally installed bin, starts the daemon. On macOS, when
// the CLI carries com.apple.provenance, the daemon is launched through
// LaunchServices (a background-only process outside the CLI's process tree),
// so its git and gh spawns stay fast: the invented sample-shop repo's changes
// and its city appear within 5 s of `start` returning. `diffcity stop` then
// stops that daemon and no start report is left in the home.
// Recorded by `npm run proof -- DC-45`.

import { execFile, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { delimiter, dirname } from 'node:path';
import type { RepoDetail } from '../../../src/core/model/types.js';
import { hasProvenance } from '../../../src/daemon/client.js';
import { CLI_DIST } from '../../helpers/daemon.js';
import { buildSampleShop, ghStubEnv, samplePrs } from '../support/acceptance.js';
import { criterion, expect, test, titleCard } from '../support/proof.js';
import { waitReady } from '../support/scene.js';

const DEADLINE_MS = 5000;

/** Runs the built CLI by executing it (its `#!/usr/bin/env node` finds this node first). */
function runShim(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const shimEnv = { ...env, PATH: `${dirname(process.execPath)}${delimiter}${env['PATH'] ?? ''}` };
  return new Promise((resolve) => {
    execFile(CLI_DIST, args, { env: shimEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
    });
  });
}

/** The LaunchServices application type of `pid` (`BackgroundOnly`), or '' when LaunchServices does not know it. */
function launchServicesType(pid: number): string {
  const asn = spawnSync('/usr/bin/lsappinfo', ['find', `pid=${String(pid)}`], { encoding: 'utf8' }).stdout.trim();
  if (asn === '') return '';
  const info = spawnSync('/usr/bin/lsappinfo', ['info', '-only', 'ApplicationType', asn], { encoding: 'utf8' }).stdout;
  return /"ApplicationType"="([^"]+)"/.exec(info)?.[1] ?? '';
}

const getJson = async <T>(url: string): Promise<T> => (await (await fetch(url)).json()) as T;

test('DC-45: a daemon started through the provenance-tagged shim lists changes within 5 s', async ({ page, proof }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: 'dark' });
  const tagged = process.platform === 'darwin' && hasProvenance(CLI_DIST);
  await titleCard(page, 'DC-45: diffcity start through the shim', [
    'The built CLI is executed directly, as a globally installed `diffcity` bin is.',
    `dist/cli/index.js carries com.apple.provenance: ${String(tagged)}`,
    'sample-shop: an invented repo with a local branch, an open PR and uncommitted work.',
  ]);
  const { repo, prHead } = await buildSampleShop();
  proof.onTeardown(() => repo.cleanup());
  const env = await ghStubEnv(proof.root, proof.env, samplePrs(prHead));
  const base = proof.baseURL;
  const state: { repoId: string; pid: number; startedAt: number; changeId: number } = { repoId: '', pid: 0, startedAt: 0, changeId: 0 };

  await criterion(
    page,
    '1. diffcity start, executed through the shim, starts the daemon',
    async () => {
      const started = await runShim(['start', repo.dir, '--no-open', '--port', String(proof.port)], env);
      state.startedAt = performance.now();
      expect(started.code, started.stderr).toBe(0);
      const id = /#\/repo\/(\d+)$/m.exec(started.stdout)?.[1];
      expect(id, started.stdout).toBeDefined();
      state.repoId = String(id);
      state.pid = (await getJson<{ pid: number }>(`${base}/api/health`)).pid;
      // On a tagged CLI the daemon is a LaunchServices launch that stays out of the Dock.
      if (tagged) expect(launchServicesType(state.pid)).toBe('BackgroundOnly');
    },
    tagged ? 'launched through LaunchServices: a BackgroundOnly process, not a child of the CLI' : 'a detached child of the CLI',
  );

  await criterion(
    page,
    '2. The repo lists its 3 changes within 5 s of start returning',
    async () => {
      await page.goto(`${base}/?scene-debug#/repo/${state.repoId}`);
      await expect(page.getByTestId('change-row')).toHaveCount(3, { timeout: DEADLINE_MS });
      const detail = await getJson<RepoDetail>(`${base}/api/repos/${state.repoId}`);
      expect(detail.changes.every((change) => change.stats !== null)).toBe(true);
      const elapsed = performance.now() - state.startedAt;
      test.info().annotations.push({ type: 'measured', description: `3 changes on screen ${elapsed.toFixed(0)} ms after start returned` });
      expect(elapsed).toBeLessThan(DEADLINE_MS);
      const first = detail.changes[0];
      if (first === undefined) throw new Error('no change');
      state.changeId = first.id;
    },
    'the daemon’s git and gh spawns are not slowed by the shim’s provenance',
  );

  await criterion(page, '3. A change opens as a city', async () => {
    await page.locator(`[data-testid="change-row"][data-change-id="${String(state.changeId)}"]`).getByTestId('change-title').click();
    await expect(page).toHaveURL(new RegExp(`#/change/${String(state.changeId)}$`));
    await waitReady(page);
    await expect(page.getByTestId('city-canvas')).toBeVisible();
  });

  await criterion(
    page,
    '4. diffcity stop stops the LaunchServices daemon; no start report is left',
    async () => {
      const stopped = await runShim(['stop'], env);
      expect(stopped.code, stopped.stderr).toBe(0);
      await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'offline', { timeout: 10_000 });
      expect(spawnSync('/bin/kill', ['-0', String(state.pid)]).status).not.toBe(0);
      expect((await readdir(proof.home)).filter((name) => name.startsWith('start-'))).toEqual([]);
    },
    'the top bar goes offline and the daemon process is gone',
  );
});
