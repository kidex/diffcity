// Proof video for DC-86: the Fleet's first paint no longer stalls the main
// thread under CPU raster (the proof project runs Chromium on SwiftShader).
// The real daemon from dist/, in a temporary home: the Fleet is empty, then
// the invented sample-shop repo is tracked and its lot appears; the lot's
// look is the mockup's (soft shadow, shaded face, plot grid, ground grid and
// glow), drawn without gradients, masks or blur. A 50 ms heartbeat in the page
// reports the longest gap. Recorded by `npm run proof -- DC-86`.

import { spawn } from 'node:child_process';
import { CLI_DIST } from '../../helpers/daemon.js';
import { buildSampleShop, ghStubEnv, samplePrs } from '../support/acceptance.js';
import { criterion, expect, hideCaption, HOLD_MS, showCaption, test, titleCard } from '../support/proof.js';

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

const HEARTBEAT = `
  window.beat = { last: performance.now(), max: 0 };
  setInterval(() => {
    const now = performance.now();
    window.beat.max = Math.max(window.beat.max, now - window.beat.last);
    window.beat.last = now;
  }, 50);
`;

test('DC-86: the Fleet paints its first lot without stalling the page', async ({ page, proof }) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(HEARTBEAT);
  await titleCard(page, 'DC-86: a Fleet first paint that does not stall', [
    'The real daemon from dist/, in a temporary home; Chromium on software raster.',
    'sample-shop: an invented repo with a Draft, a Branch and a PR (#7).',
    'A 50 ms heartbeat in the page measures the longest main-thread gap.',
  ]);
  const { repo, prHead } = await buildSampleShop();
  proof.onTeardown(() => repo.cleanup());
  const env = await ghStubEnv(proof.root, proof.env, samplePrs(prHead));
  await proof.startDaemon(env);

  await criterion(page, '1. The Fleet is empty before a repo appears', async () => {
    await page.goto(`${proof.baseURL}/#/`);
    await expect(page.getByTestId('daemon')).toHaveAttribute('data-state', 'connected');
    await expect(page.getByTestId('fleet-empty')).toBeVisible();
  });

  await criterion(page, '2. Tracking sample-shop makes its lot appear, with the same look', async () => {
    // Measure from here: the first paint of a lot, not the page load before it.
    await page.evaluate('window.beat.max = 0');
    await cli(['track', repo.dir], env);
    await expect(page.getByTestId('lot')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('repo-row')).toHaveCount(1);
    await page.waitForTimeout(500);
  });

  await criterion(page, '3. The page stayed responsive while the lot was painted', async () => {
    const max = Math.round(await page.evaluate<number>('window.beat.max'));
    await showCaption(page, `Longest main-thread gap: ${String(max)} ms`, 'Before the change the first Fleet paint stalled the page for about 2 s under software raster.');
    expect(max).toBeLessThan(500);
    await page.waitForTimeout(HOLD_MS * 2);
    await hideCaption(page);
  });

  await criterion(page, '4. Hovering the lot lifts it and shows the card', async () => {
    await page.getByTestId('lot').hover();
    await expect(page.locator('.fleet-map .tip.show')).toBeVisible();
    await page.waitForTimeout(HOLD_MS);
  });
});
