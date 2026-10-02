// Proof video for DC-35 (e2e/cd-to-ui, SPEC.md sections 3a and 9): with the
// real daemon running and the UI open on the Fleet, a zsh with the built
// `diffcity shell-init` hook `cd`s into the invented sample-shop repo; the
// Fleet shows it with one Draft, one Branch and one PR, and its Repo screen
// lists the 3 changes. Recorded by `npm run proof -- DC-35`.

import type { Page } from '@playwright/test';
import { createRepo } from '../../helpers/repo.js';
import { buildSampleShop, cdLine, ghStubEnv, installedShells, samplePrs } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, test, titleCard } from '../support/proof.js';

const WAIT_MS = 30_000;

/** Waits until the Fleet shows the lot and the row of `name` with one Draft, one Branch and one PR. */
async function waitForFleetRow(page: Page, name: string): Promise<void> {
  const repoName = JSON.stringify(name);
  await page.waitForFunction(
    `(() => {
      const lot = [...document.querySelectorAll('[data-testid="lot"]')].find((element) =>
        (element.getAttribute('aria-label') ?? '').startsWith(${repoName} + ','));
      const row = [...document.querySelectorAll('[data-testid="repo-row"]')].find((element) =>
        (element.querySelector('[data-col="repo"]')?.textContent ?? '').includes(${repoName}));
      if (lot === undefined || row === undefined) return false;
      const count = (column) => row.querySelector('[data-col="' + column + '"]')?.textContent?.trim() ?? '';
      return count('draft') === '1' && count('branch') === '1' && count('pr') === '1';
    })()`,
    undefined,
    { polling: 100, timeout: WAIT_MS },
  );
}

/** Waits until the Repo screen of `name` lists its Draft, Branch and PR with their stats computed. */
async function waitForRepoScreen(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    `(() => {
      const screen = document.querySelector('[data-screen="repo"]');
      if (screen === null || screen.querySelector('h1')?.textContent !== ${JSON.stringify(name)}) return false;
      const rows = [...screen.querySelectorAll('[data-testid="change-row"]')];
      if (rows.length !== 3 || screen.querySelector('[data-testid="computing"]') !== null) return false;
      return rows.map((row) => row.getAttribute('data-kind')).sort().join(',') === 'branch,draft,pr';
    })()`,
    undefined,
    { polling: 100, timeout: WAIT_MS },
  );
}

const zsh = installedShells().find((spec) => spec.shell === 'zsh');

test('DC-35: cd into a repo in zsh and it appears in the UI with its 3 changes', async ({ page, proof }) => {
  test.skip(zsh === undefined, 'zsh is not installed');
  if (zsh === undefined) return;

  await titleCard(page, 'DC-35: cd into a repo and it appears in the UI', [
    'The real daemon from dist/, in a temporary home.',
    'sample-shop: an invented repo with a Draft, a Branch and a PR (#7).',
    'zsh with the hook printed by diffcity shell-init.',
  ]);
  const { repo, prHead } = await buildSampleShop();
  proof.onTeardown(() => repo.cleanup());
  const env = await ghStubEnv(proof.root, proof.env, samplePrs(prHead));
  // A second repo the shell never visits: it must stay off the Fleet.
  const other = await createRepo({ name: 'sample-garden', files: { 'src/beds/water.ts': 'export const water = 2;\n' } });
  proof.onTeardown(() => other.cleanup());
  await proof.startDaemon(env);
  const shell = await proof.shell(zsh, env);

  await criterion(page, 'The daemon runs and the UI is open on an empty Fleet', async () => {
    await page.goto(`${proof.baseURL}/#/`);
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
    await expect(page.getByTestId('fleet-empty')).toBeVisible();
  });

  await criterion(
    page,
    '1. cd into sample-shop in zsh, with no other command',
    async () => {
      shell.run(cdLine(zsh, repo.dir));
      await waitForFleetRow(page, 'sample-shop');
    },
    'zsh $ cd sample-shop        (diffcity shell-init hook loaded)',
  );

  await criterion(page, '2. The Fleet shows sample-shop: 1 Draft, 1 Branch, 1 PR', async () => {
    const row = page.getByTestId('repo-row').filter({ hasText: 'sample-shop' });
    await expect(row).toBeVisible();
    await row.hover();
    await expect(page.getByTestId('repo-row').filter({ hasText: 'sample-garden' })).toHaveCount(0);
  });

  await criterion(page, '3. Its Repo screen lists the 3 changes: the Draft, the Branch and the PR', async () => {
    await page.getByTestId('repo-row').filter({ hasText: 'sample-shop' }).getByRole('link', { name: 'sample-shop' }).click();
    await waitForRepoScreen(page, 'sample-shop');
    await expect(page.getByTestId('change-title').filter({ hasText: 'add the menu' })).toBeVisible();
    await expect(page.getByTestId('change-title').filter({ hasText: 'Checkout flow' })).toBeVisible();
  });

  // The screen itself, without the caption, then a closing card: the video
  // keeps recording while the fixture stops the daemon, and that must not
  // end the video on a disconnected UI.
  await hideCaption(page);
  await page.waitForTimeout(HOLD_MS);
  await titleCard(page, 'DC-35: all criteria hold', [
    '1. cd into sample-shop in zsh, with no other command',
    '2. The Fleet shows sample-shop: 1 Draft, 1 Branch, 1 PR',
    '3. Its Repo screen lists the 3 changes',
  ]);
  await page.waitForTimeout(HOLD_MS);
  expect(shell.output()).not.toMatch(/\[\d+\]|tracked|error/i);
});
