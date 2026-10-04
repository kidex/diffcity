// e2e/change/marks-persist-reload-and-outdate (SPEC.md section 9, ADR-028,
// phase 3 exit criterion 4): the real daemon from dist/ with the
// order-discounts change. A file is marked Checked through the UI and the
// mark persists across a reload. A new snapshot that leaves the marked code
// unchanged (an agent edits another file) keeps the mark current; a change to
// the marked code makes it outdated, and the open page says so.

import { appendFunction, getJson, GUARD, SERVICE, stubEnv, trackScenario, until, type TrackedChange } from '../support/change-daemon.js';
import { expect, test } from '../support/proof.js';
import { card, cardButton } from '../support/review.js';
import { project, selectedFloor, waitForCityAttribute, waitReady } from '../support/scene.js';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const HINT = 'changed since you checked it';

/** The part of the review route this spec reads. */
interface ReviewState {
  marks: { targetKind: string; targetId: string; mark: string; state: string }[];
}

test('change/marks-persist-reload-and-outdate', async ({ proof, page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  const reviewUrl = `${proof.baseURL}/api/changes/${String(tracked.change.id)}/review`;
  const review = (): Promise<ReviewState> => getJson<ReviewState>(reviewUrl);

  await page.goto(tracked.url);
  await waitReady(page);
  const attention = page.getByTestId('progress-attention');
  await expect(attention).toHaveText('0 of 2 files that need your eyes checked');

  // Mark the guard Checked through the UI: select the building, ask for the whole file, press C.
  await pick(page, GUARD);
  expect(await selectedFloor(page)).not.toBeNull();
  await page.keyboard.press('c');
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  await expect(attention).toHaveText('1 of 2 files that need your eyes checked');
  await expect.poll(async () => (await review()).marks.map((m) => `${m.targetKind}:${m.targetId}:${m.mark}:${m.state}`)).toEqual([`file:${GUARD}:checked:current`]);

  // The daemon stored it: a reload shows it again.
  await page.reload();
  await waitReady(page);
  await expect(attention).toHaveText('1 of 2 files that need your eyes checked');
  await pick(page, GUARD);
  await expect(cardButton(page, 'checked')).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page).getByTestId('mark-outdated')).toHaveCount(0);

  // A new snapshot that leaves the guard unchanged: an agent edits the service file.
  await appendFunction(tracked.repo, SERVICE, 'applyLoyaltyBonus');
  // The daemon applies the outdated rule when it stores the snapshot, so once the Report has the new floor the rule has run.
  await until(async () => (await hasSymbol(tracked, SERVICE, 'applyLoyaltyBonus')) || undefined, 60_000, 'the new snapshot');
  expect((await review()).marks.map((m) => m.state)).toEqual(['current']);
  await page.reload();
  await waitReady(page);
  await expect(attention).toHaveText('1 of 2 files that need your eyes checked');
  await expect(page.getByTestId('progress-outdated')).toHaveCount(0);
  await pick(page, GUARD);
  await expect(card(page).getByTestId('mark-current')).toHaveText('Checked');
  await expect(card(page).getByTestId('mark-outdated')).toHaveCount(0);

  // The marked code changes: the mark is outdated, on the open page without a reload and after one.
  const current = await readFile(join(tracked.repo.dir, GUARD), 'utf8');
  await tracked.repo.write({ [GUARD]: current.replace('return order ? order.ownerId === user.id : true;', 'return order !== undefined && order.ownerId === user.id;') });
  await expect.poll(async () => (await review()).marks[0]?.state, { timeout: 60_000 }).toBe('outdated');
  await expect(attention).toHaveText('0 of 2 files that need your eyes checked', { timeout: 30_000 });
  await expect(page.getByTestId('progress-outdated')).toHaveText('1 changed since you checked it');
  await expect(card(page).getByTestId('mark-outdated')).toHaveText(HINT);
  await expect(cardButton(page, 'checked')).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await waitReady(page);
  await expect(attention).toHaveText('0 of 2 files that need your eyes checked');
  await pick(page, GUARD);
  await expect(card(page).getByTestId('mark-outdated')).toHaveText(HINT);
});

/** Whether the latest Report has `name` among the symbols of `file`. */
async function hasSymbol(tracked: TrackedChange, file: string, name: string): Promise<boolean> {
  const report = await tracked.report();
  return report.packages.flatMap((pkg) => pkg.files).find((candidate) => candidate.id === file)?.symbols.some((symbol) => symbol.name === name) === true;
}

/** Selects the building and asks for the whole file (a click lands on a floor, the default target). */
async function pick(page: Page, file: string): Promise<void> {
  if (await card(page).isVisible()) {
    await page.keyboard.press('Escape');
    await waitForCityAttribute(page, 'data-selected', '');
  }
  const point = await project(page, file);
  await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', file);
  await card(page).getByTestId('mark-scope-file').click();
}
