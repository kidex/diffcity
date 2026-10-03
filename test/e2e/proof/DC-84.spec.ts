// Proof video for DC-84 (ADR-002): the change screen renders from a Report
// alone. No daemon and no server: a generated HTML file with the Report of the
// invented order-discounts change embedded is opened from file://. On screen:
// the city and its panel, a verdict filter, a click on a building, J and K
// along the reading path, the file view with the Report's step diffs and
// "Full diff is available in the app", and the absence of review controls, of
// the Fleet card and of a live indicator. Recorded by `npm run proof -- DC-84`.

import { GUARD, SERVICE } from '../support/hud.js';
import { panelReport, stopCards } from '../support/panel.js';
import { criterion, expect, titleCard } from '../support/proof.js';
import { project, selected, waitForCityAttribute, waitReady } from '../support/scene.js';
import { test } from '../support/standalone.js';

test('DC-84 the change screen renders from an embedded Report', async ({ page, standalone }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await titleCard(page, 'DC-84: the change screen from a Report alone', [
    'A standalone page opened from file://, with the Report embedded in the HTML.',
    'No daemon, no server, no network: three.js and the fonts are bundled.',
  ]);
  await standalone.open(panelReport(), { waitForCity: false });
  await waitReady(page);

  await criterion(page, 'The city and the reading panel render from the embedded Report', async () => {
    await expect(page.getByTestId('city')).toBeVisible();
    await expect(page.getByTestId('reading-panel')).toBeVisible();
    await expect(stopCards(page)).toHaveCount(5);
  });

  await criterion(page, 'Filters dim the other buildings', async () => {
    const eyes = page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Needs your eyes/ });
    await eyes.click();
    await expect(eyes).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(600);
    await eyes.click();
  });

  await criterion(page, 'Hover and select a building, orbit the city', async () => {
    const guard = await project(page, GUARD);
    await page.mouse.move(guard.x, guard.y, { steps: 6 });
    await expect(page.getByTestId('tooltip')).toBeVisible();
    await page.mouse.click(guard.x, guard.y);
    await waitForCityAttribute(page, 'data-selected', GUARD);
    await page.mouse.move(guard.x + 200, guard.y + 260, { steps: 4 });
    await page.mouse.down();
    await page.mouse.move(guard.x + 380, guard.y + 240, { steps: 20 });
    await page.mouse.up();
  });

  await criterion(page, 'J and K walk the reading path', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect.poll(() => selected(page)).toBe(SERVICE);
    await page.keyboard.press('k');
    await expect.poll(() => selected(page)).toBe(GUARD);
  });

  await criterion(page, 'The file view shows the step diffs and says the full diff is in the app', async () => {
    const service = await project(page, SERVICE);
    await page.mouse.click(service.x, service.y);
    await waitForCityAttribute(page, 'data-selected', SERVICE);
    await expect(page.getByTestId('file-diff').getByTestId('diff-excerpt')).toHaveCount(2);
    await expect(page.getByTestId('diff-in-app')).toHaveText('Full diff is available in the app');
  });

  await criterion(page, 'No review controls, no Fleet card, no live indicator', async () => {
    await expect(page.getByTestId('fleet-card')).toHaveCount(0);
    await expect(page.getByTestId('daemon')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^mark\b|needs rewrite|copy summary/i, disabled: false })).toHaveCount(0);
  });
});
