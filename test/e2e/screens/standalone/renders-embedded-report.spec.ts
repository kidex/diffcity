// e2e/standalone/renders-embedded-report (ADR-002, SPEC.md section 10): the
// change screen works from a Report alone. The page is opened from file://
// on a generated HTML with the Report in a JSON script element, no server and
// no daemon: the city, the filters, hover, selection, the reading panel and
// J/K all work, as they do in the SPA.

import { expect as baseExpect } from '@playwright/test';
import { GUARD, MIGRATION, paintDump, SERVICE } from '../../support/hud.js';
import { panelReport, stopCards, tab } from '../../support/panel.js';
import { hasWebgl2, hovered, project, selected, selectedFloor, stats, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';
import { test } from '../../support/standalone.js';

test.describe.configure({ timeout: 60_000 });

test('standalone/renders-embedded-report', async ({ page, standalone }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const report = panelReport();
  await standalone.open(report);
  expect(page.url()).toMatch(/^file:\/\//);

  // The city: a building per file, a lot per package, a label per touched file.
  expect(await hasWebgl2(page)).toBe(true);
  const files = report.packages.flatMap((pkg) => pkg.files);
  const scene = await stats(page);
  expect(scene.buildings).toBe(files.length);
  expect(scene.lots).toBe(report.packages.length);
  expect(scene.labels).toBe(files.filter((file) => file.status !== 'same').length);
  await expect(page.getByTestId('hud-bar')).toBeVisible();
  await expect(page.getByTestId('roof-label').and(page.locator(`[data-building="${GUARD}"]`)).locator('.badge')).toHaveText('Needs your eyes');
  // Bundled fonts are in use, from local files.
  await page.waitForFunction("document.fonts.status === 'loaded'");
  expect(await page.evaluate("document.fonts.check('600 14px Sora')")).toBe(true);

  // Filters: a verdict chip dims the other buildings, the same chip again turns it off.
  const eyes = page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Needs your eyes/ });
  await eyes.click();
  await expect(eyes).toHaveAttribute('aria-pressed', 'true');
  expect((await paintDump(page)).dimmed.sort()).toEqual(
    files
      .filter((file) => file.verdict !== 'eyes')
      .map((file) => file.id)
      .sort(),
  );
  await eyes.click();
  await expect.poll(async () => (await paintDump(page)).dimmed).toEqual([]);

  // Hover shows the tooltip of the building under the pointer.
  const guard = await project(page, GUARD);
  await page.mouse.move(guard.x, guard.y, { steps: 3 });
  await waitForCityAttribute(page, 'data-hovered', GUARD);
  expect(await hovered(page)).toBe(GUARD);
  await expect(page.getByTestId('tooltip').getByTestId('tip-file')).toHaveText('order.guard.ts');

  // The reading panel: four tabs with their counters, five stops in order.
  await expect(page.getByTestId('reading-panel').getByRole('heading', { name: 'Reading path' })).toBeVisible();
  await expect(tab(page, 'order')).toHaveText('Execution order5');
  await expect(tab(page, 'findings')).toHaveText('Findings5');
  await expect(stopCards(page)).toHaveCount(5);

  // Selection: a click selects the building, shows the card and opens the file view; Escape clears.
  await page.mouse.click(guard.x, guard.y);
  await waitForCityAttribute(page, 'data-selected', GUARD);
  await expect(page.getByTestId('selection-card').getByTestId('card-file')).toHaveText(GUARD);
  await expect(page.getByTestId('file-view')).toBeVisible();
  await page.keyboard.press('Escape');
  await waitForCityAttribute(page, 'data-selected', '');
  await expect(page.getByTestId('file-view')).toBeHidden();

  // J and K walk the stops, the city follows.
  await page.keyboard.press('j');
  await expect.poll(() => selected(page)).toBe(GUARD);
  await page.keyboard.press('j');
  await expect.poll(() => selected(page)).toBe(SERVICE);
  await expect.poll(() => selectedFloor(page)).toBe(`${SERVICE}#OrdersService.place`);
  await expect(stopCards(page).nth(1)).toHaveClass(/\bon\b/);
  await page.keyboard.press('k');
  await expect.poll(() => selected(page)).toBe(GUARD);
  await expect(stopCards(page).nth(0)).toHaveClass(/\bon\b/);
  // A click on a building of another package selects it too.
  const migration = await project(page, MIGRATION);
  await page.mouse.click(migration.x, migration.y);
  await waitForCityAttribute(page, 'data-selected', MIGRATION);
});

test('standalone/renders-embedded-report-malformed', async ({ page, standalone }) => {
  // A report that is not JSON, with markup in it: a plain message, no city, nothing parsed as HTML.
  await standalone.open({ raw: '{ "packages": [ <img src=x onerror="window.pwned = 1"> ' }, { waitForCity: false });
  const message = page.getByTestId('standalone-error');
  await expect(message).toHaveText('The embedded report is not valid JSON.');
  await expect(message).toHaveAttribute('role', 'alert');
  baseExpect(await page.locator('img').count()).toBe(0);
  await expect(page.getByTestId('city')).toHaveCount(0);
  baseExpect(await page.evaluate('window.pwned')).toBeUndefined();

  // Valid JSON that is not a Report.
  await standalone.open({ raw: '{"hello": "world"}' }, { waitForCity: false });
  await expect(page.getByTestId('standalone-error')).toHaveText('The embedded report is not a diffcity Report.');
});
