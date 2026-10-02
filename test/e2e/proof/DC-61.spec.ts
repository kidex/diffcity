// Proof video for DC-61 (ADR-030): the real daemon from dist/, in a temporary
// home, tracks the invented sample-bakery repo, which has a diffcity.config.js
// and is not trusted. The Fleet marks it with a note; the Repo screen explains
// the note and shows the trust command. Recorded by `npm run proof -- DC-61`.

import { spawn } from 'node:child_process';
import type { RepoSummary } from '../../../src/core/model/types.js';
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

test('DC-61: an untrusted repo with a config shows a note on the Fleet and the Repo screen', async ({ page, proof }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ colorScheme: 'dark' });
  await titleCard(page, 'DC-61: repo notes in the Fleet and the Repo screen', [
    'The real daemon from dist/, in a temporary home.',
    'sample-bakery: an invented repo with a diffcity.config.js that is not trusted.',
  ]);
  const repo = await createRepo({
    name: 'sample-bakery',
    files: {
      'diffcity.config.js': 'export default { base: "develop" };\n',
      'src/menu/bread.ts': 'export function bread(): string {\n  return "rye";\n}\n',
    },
  });
  proof.onTeardown(() => repo.cleanup());
  const env = await ghStubEnv(proof.root, proof.env, []);
  await proof.startDaemon(env);
  await cli(['track', repo.dir], env);
  const base = proof.baseURL;
  const found = await waitFor(async () => {
    const repos = await getJson<RepoSummary[]>(`${base}/api/repos`);
    return repos.find((candidate) => candidate.name === 'sample-bakery' && candidate.notes.length > 0);
  }, 60_000, 'sample-bakery with its note in /api/repos');

  await criterion(page, '1. An untrusted repo with a config shows a note on the Fleet', async () => {
    await page.goto(`${base}/#/`);
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
    const tag = page.getByTestId('repo-note-indicator');
    await expect(tag).toHaveCount(1);
    await expect(page.getByTestId('lot-note')).toHaveCount(1);
    await expect(tag).toHaveAttribute('aria-label', /isn’t trusted/);
    await tag.hover();
    await page.waitForTimeout(1500);
  });

  await criterion(page, '2. The Repo screen explains it and shows the trust command', async () => {
    await page.goto(`${base}/#/repo/${String(found.id)}`);
    const banner = page.getByTestId('repo-note');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Defaults are used for the base and tier 1.');
    await expect(banner.getByTestId('note-command')).toHaveText(`diffcity trust ${found.path}`);
    await page.waitForTimeout(HOLD_MS);
  });

  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-61: all criteria hold', [
    '1. An untrusted repo with a config shows a note on the Fleet',
    '2. The Repo screen explains it and shows the trust command',
  ]);
  await page.waitForTimeout(HOLD_MS);
});
