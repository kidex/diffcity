// Proof video for DC-116 (phase 4 T10): Approve in the change screen's top bar
// against the real daemon from dist/, in a temporary home, on the invented
// order-discounts change (two touched tier 1 files: the migration and the
// guard). Approve stays closed until the daemon's progress says both have a
// current mark, asks to confirm inline, and shows the approved badge with the
// short head; Undo goes back. A refusal shows its reason. A new commit on the
// guard moves the head: the daemon resets the change to unreviewed and the
// badge goes. Recorded by `npm run proof -- DC-116`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeSummary } from '../../../src/core/model/types.js';
import { getJson, GUARD, stubEnv, trackScenario, until } from '../support/change-daemon.js';
import { MIGRATION } from '../support/hud.js';
import { criterion, expect, HOLD_MS, test, titleCard } from '../support/proof.js';
import { camera, project, waitForCityAttribute, waitReady } from '../support/scene.js';

test('DC-116: Approve in the top bar, with the server check', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-116: Approve in the change screen top bar', [
    'The real daemon from dist/, in a temporary home, on the invented order-discounts change.',
    'Two touched tier 1 files: the migration and src/auth/order.guard.ts.',
    'The gate is the daemon’s: the review progress it serves, and its own check on Approve.',
  ]);
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  const changeUrl = `${proof.baseURL}/api/changes/${String(tracked.change.id)}`;
  const head = tracked.change.head;
  const short = head.slice(0, 7);

  await page.goto(tracked.url);
  await waitReady(page);
  await expect
    .poll(
      async () => {
        const before = JSON.stringify(await camera(page));
        await page.waitForTimeout(400);
        return before === JSON.stringify(await camera(page));
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const approve = page.getByTestId('approve');
  const badge = page.getByTestId('approved-badge');
  const reviewTag = page.getByTestId('change-head').locator('.tag.review');
  const card = page.getByTestId('selection-card');
  const checkFile = async (file: string): Promise<void> => {
    if (await card.isVisible()) {
      await page.keyboard.press('Escape');
      await waitForCityAttribute(page, 'data-selected', '');
    }
    const point = await project(page, file);
    await page.mouse.move(point.x, point.y, { steps: 12 });
    await page.mouse.click(point.x, point.y);
    await waitForCityAttribute(page, 'data-selected', file);
    await card.getByTestId('mark-scope-file').click();
    await page.keyboard.press('c');
    await expect(card.getByTestId('mark-current')).toHaveText('Checked');
  };

  await criterion(
    page,
    '1. Approve is closed until every touched tier 1 file has a current mark',
    async () => {
      await expect(approve).toHaveText('Approve when tier 1 is read');
      await expect(approve).toHaveAttribute('aria-disabled', 'true');
      await expect(approve).toHaveAttribute('title', '0 of 2 touched tier 1 files have a current review mark');
      await approve.hover();
      await checkFile(GUARD);
      await expect(approve).toHaveAttribute('title', '1 of 2 touched tier 1 files have a current review mark');
      await approve.hover();
    },
    'the count is progress.tier1 from the daemon: 1 of 2 after checking the guard',
  );

  await criterion(
    page,
    '2. Both tier 1 files checked: Approve opens',
    async () => {
      await checkFile(MIGRATION);
      await expect(approve).toHaveText('Approve');
      await expect(approve).not.toHaveAttribute('aria-disabled');
      await approve.hover();
    },
    'All 2 touched tier 1 files have a current review mark',
  );

  await criterion(
    page,
    '3. A refusal shows its reason; the button goes back to Approve',
    async () => {
      // One request answered with the daemon's refusal shape (a mark that went stale between the progress and the click).
      await page.route(
        `**/api/changes/${String(tracked.change.id)}/approve`,
        (route) =>
          route.fulfill({
            status: 409,
            json: { error: { code: 'tier1-unchecked', message: `1 touched tier 1 file(s) have no current review mark: ${GUARD}` } },
          }),
        { times: 1 },
      );
      await approve.click();
      await expect(page.getByRole('group', { name: 'Confirm approve' })).toContainText(`Approve ${short}?`);
      await page.waitForTimeout(HOLD_MS / 2);
      await page.getByTestId('approve-confirm').click();
      await expect(page.getByTestId('approve-error')).toHaveText(`1 touched tier 1 file(s) have no current review mark: ${GUARD}`);
      await expect(approve).toHaveText('Approve');
      await expect(badge).toHaveCount(0);
    },
    'this one answer is stubbed in the page with the daemon’s 409 tier1-unchecked; the next request goes to the daemon',
  );

  await criterion(
    page,
    '4. Approve, confirm inline: the daemon approves, the bar shows the short head',
    async () => {
      await approve.click();
      await expect(page.getByTestId('approve-confirm')).toBeFocused();
      await page.waitForTimeout(HOLD_MS / 2);
      await page.getByTestId('approve-confirm').click();
      await expect(badge).toHaveText(`Approved ${short}`);
      await expect(reviewTag).toHaveText('Approved');
      const change = await getJson<ChangeSummary>(changeUrl);
      expect(change.reviewState).toBe('approved');
      expect(change.approvedHead).toBe(head);
    },
    `GET /api/changes/:id → reviewState approved, approvedHead ${short}`,
  );

  await criterion(
    page,
    '5. Undo approve: back to in review, then approved again',
    async () => {
      await page.getByTestId('approve-undo').click();
      await expect(approve).toHaveText('Approve');
      await expect(reviewTag).toHaveText('In review');
      await page.waitForTimeout(HOLD_MS / 2);
      await approve.click();
      await page.getByTestId('approve-confirm').click();
      await expect(badge).toHaveText(`Approved ${short}`);
    },
    'DELETE /api/changes/:id/approve, then POST again',
  );

  await criterion(
    page,
    '6. The agent commits on the guard: the head moves, the change is unreviewed again',
    async () => {
      const current = await readFile(join(tracked.repo.dir, GUARD), 'utf8');
      const next = await tracked.repo.commit('Retry the owner check', {
        [GUARD]: `${current}\nexport function retryOwnerCheck(attempts: number): number {\n  return attempts + 1;\n}\n`,
      });
      await until(async () => (await getJson<ChangeSummary>(changeUrl)).head === next, 60_000, 'the new head on the change');
      await expect(badge).toHaveCount(0, { timeout: 60_000 });
      await expect(reviewTag).toHaveText('Unreviewed', { timeout: 60_000 });
      await expect(approve).toHaveText('Approve when tier 1 is read', { timeout: 60_000 });
      await expect(approve).toHaveAttribute('title', '1 of 2 touched tier 1 files have a current review mark');
      await approve.hover();
    },
    'the daemon reset the review state (ADR-019); the guard’s mark is outdated, so the gate is closed again',
  );
});
