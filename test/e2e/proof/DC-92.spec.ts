// Proof video for DC-92 (phase 3): a golden change on a real daemon. The real
// daemon from dist/, in a temporary home, collects the order-discounts change
// of the golden scenarios; the screen shows its city, a verdict filter, the file
// view with the real diff of the guard, a mark that is stored, and an agent's
// edit that adds a floor while the screen stays open. Recorded by
// `npm run proof -- DC-92`.

import { appendFunction, GUARD, SERVICE, stubEnv, trackScenario } from '../support/change-daemon.js';
import { criterion, expect, hideCaption, HOLD_MS, showCaption, test, titleCard } from '../support/proof.js';
import { project, stats, waitForCityAttribute, waitReady } from '../support/scene.js';

test('DC-92: a golden change on a real daemon, from city to review mark to a live edit', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-92: the change screen on a real daemon', [
    'The real daemon from dist/, in a temporary home.',
    'order-discounts: an invented repo with three commits on a feature branch.',
    'City, filter, file view with the real diff, a review mark, an edit arriving live.',
  ]);
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');

  await criterion(page, '1. The daemon collected the change and the screen draws its city', async () => {
    await page.goto(tracked.url);
    await waitReady(page);
    await expect(page.getByTestId('stat-files')).toHaveText('17files');
    await expect(page.getByTestId('eyes-badge')).toHaveText('2 files need your eyes before merge');
    await expect(page.getByTestId('roof-label').first()).toBeVisible();
  });

  await criterion(page, '2. A verdict filter dims everything else', async () => {
    await page.getByTestId('filter-verdict-eyes').click();
    await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=eyes;type=;rule=');
    await page.waitForTimeout(HOLD_MS);
    await page.getByTestId('filter-clear').click();
    await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=;rule=');
  });

  await criterion(page, '3. A click opens the file view with the diff the daemon computed', async () => {
    const point = await project(page, GUARD);
    await page.mouse.move(point.x, point.y, { steps: 6 });
    await page.mouse.click(point.x, point.y);
    await waitForCityAttribute(page, 'data-selected', GUARD);
    await expect(page.getByTestId('diff-view')).toHaveAttribute('data-state', 'text');
    await expect(page.getByTestId('diff-stats')).toHaveText('+6 −2');
  });

  await criterion(page, '4. Marking the file Checked is stored by the daemon', async () => {
    await page.getByTestId('selection-card').getByTestId('mark-scope-file').click();
    await page.keyboard.press('c');
    await expect(page.getByTestId('progress-attention')).toHaveText('1 of 2 files that need your eyes checked');
  });

  await criterion(page, '5. An edit in the working tree adds a floor, with no reload', async () => {
    const before = (await stats(page)).floors;
    await appendFunction(tracked.repo, SERVICE, 'applyLoyaltyBonus');
    await expect.poll(async () => (await stats(page)).floors, { timeout: 30_000 }).toBe(before + 1);
    await expect(page.getByTestId('progress-attention')).toHaveText('1 of 2 files that need your eyes checked');
    await showCaption(page, '5. The new floor arrived; selection, filters and the mark stayed');
    await page.waitForTimeout(HOLD_MS);
    await hideCaption(page);
  });
});
