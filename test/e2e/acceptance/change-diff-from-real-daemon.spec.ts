// e2e/change/diff-from-real-daemon (SPEC.md section 6, ADR-027): the real
// daemon from dist/ computes the diff of the order-discounts guard file, whose
// canPlace changed its signature (the `sig` guard). The route answers with
// rows, highlight ranges, hunks and symbol spans; the file view of the change
// screen draws exactly those, with highlighting and the hunk keys.

import type { FileDiff } from '../../../src/core/model/types.js';
import { CAN_PLACE, getJson, GUARD, stubEnv, trackScenario } from '../support/change-daemon.js';
import { expect, test } from '../support/proof.js';
import { project, waitForCityAttribute, waitReady } from '../support/scene.js';

test('change/diff-from-real-daemon', async ({ proof, page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  const tracked = await trackScenario(proof, env, 'order-discounts');
  const route = `${proof.baseURL}/api/changes/${String(tracked.change.id)}/diff?path=${encodeURIComponent(GUARD)}`;

  // The daemon's answer: text, +6 -2, three hunks, no folds in a 21-line file, the class and its two methods as spans.
  const diff = await getJson<FileDiff>(route);
  expect(diff.kind).toBe('text');
  expect(diff.stale).toBe(false);
  expect(diff.language).toBe('typescript');
  expect(diff.stats).toEqual({ added: 6, removed: 2 });
  const rows = diff.rows ?? [];
  expect(rows).toHaveLength(23);
  expect(rows.filter((row) => row.kind === 'add')).toHaveLength(6);
  expect(rows.filter((row) => row.kind === 'del')).toHaveLength(2);
  expect(diff.hunks).toEqual([
    { first: 7, last: 10 },
    { first: 16, last: 17 },
    { first: 19, last: 20 },
  ]);
  expect(diff.symbols?.map((span) => span.id)).toEqual([`${GUARD}#OrderGuard`, `${GUARD}#OrderGuard.canRead`, CAN_PLACE]);
  // Highlight ranges: `import` is a keyword, the new signature carries a function name and a type.
  expect(rows[0]?.hl).toContainEqual([0, 6, 'kw']);
  const signature = rows.find((row) => row.kind === 'add' && row.text.includes('canPlace(user: User, order?: Order)'));
  expect(signature?.hl?.some(([, , cls]) => cls === 'fn')).toBe(true);
  expect(signature?.hl?.some(([, , cls]) => cls === 'type')).toBe(true);
  // With a symbol, the daemon says which rows are that floor's.
  const focused = await getJson<FileDiff>(`${route}&symbol=${encodeURIComponent(CAN_PLACE)}`);
  expect(focused.focus).toEqual({ id: CAN_PLACE, first: 17, last: 21 });

  // The screen: click the guard's canPlace floor, the file view opens on that file.
  await page.goto(tracked.url);
  await waitReady(page);
  const point = await project(page, GUARD, CAN_PLACE);
  await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.mouse.click(point.x, point.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  const view = page.getByTestId('diff-view');
  await expect(page.getByTestId('file-view-file')).toHaveText(GUARD);
  await expect(view).toHaveAttribute('data-state', 'text');
  await expect(page.getByTestId('diff-stats')).toHaveText('+6 −2');
  // Every row of the daemon's diff is drawn, with the old and new line numbers it gave.
  const drawn = page.getByTestId('diff-row');
  await expect(drawn).toHaveCount(rows.length);
  await expect(page.locator('[data-testid="diff-row"][data-kind="add"]')).toHaveCount(6);
  await expect(page.locator('[data-testid="diff-row"][data-kind="del"]')).toHaveCount(2);
  const deleted = page.locator('[data-testid="diff-row"][data-kind="del"]').first();
  await expect(deleted.getByTestId('diff-text')).toHaveText('  canPlace(user: User): boolean {');
  await expect(deleted.getByTestId('diff-old')).toHaveText('13');
  await expect(deleted.getByTestId('diff-new')).toHaveText('');
  const added = page.locator('[data-testid="diff-row"][data-kind="add"]').nth(4);
  await expect(added.getByTestId('diff-text')).toHaveText('  canPlace(user: User, order?: Order): boolean {');
  await expect(added.getByTestId('diff-new')).toHaveText('17');
  // Highlighting: the daemon's classes become spans of the added signature and of the import line.
  await expect(added.locator('.hl-fn')).toHaveText('canPlace');
  await expect(added.locator('.hl-type').first()).toHaveText('User');
  await expect(drawn.first().locator('.hl-kw').first()).toHaveText('import');
  await expect(drawn.first().locator('.hl-str')).toHaveText("'./roles'");

  // Hunks: three of them, N and Shift+N walk them, the counter follows.
  const counter = page.getByTestId('hunk-counter');
  await expect(counter).toHaveText(/^\d \/ 3$/);
  await page.getByTestId('hunk-next').click();
  await page.keyboard.press('Shift+N');
  await page.keyboard.press('Shift+N');
  await page.keyboard.press('Shift+N');
  await expect(counter).toHaveText('1 / 3');
  await page.keyboard.press('n');
  await expect(counter).toHaveText('2 / 3');
  await page.keyboard.press('n');
  await expect(counter).toHaveText('3 / 3');
});
