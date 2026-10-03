// e2e/change/fleet-card-hidden-without-port (ADR-026): the Fleet card is an
// optional port. Without one (the SPA has no audit data to build it from yet,
// and the HTML export passes none) nothing is drawn; with one, the card shows
// the last audit of the other repos and "all N projects" goes to the Fleet
// screen. The port is injected under ?scene-debug.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/fleet-card-hidden-without-port', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);
  await expect(page.getByTestId('city')).toBeVisible();
  await expect(page.getByTestId('fleet-card')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Audit status across your projects' })).toHaveCount(0);
});

test('change/fleet-card-with-port', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(`window.diffcityFleet = {
    card: () => ({
      total: 9,
      rows: [
        { name: 'sample-ledger', age: '19 days', level: 'aging', fill: 0.63 },
        { name: 'sample-fieldops', age: '47 days, 3 new CVEs', level: 'stale', fill: 1 },
      ],
    }),
    onChange: () => () => undefined,
    open: () => { location.hash = '#/'; },
  };`);
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);
  const card = page.getByRole('complementary', { name: 'Audit status across your projects' });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('fleet-row')).toHaveCount(2);
  await expect(card.getByTestId('fleet-row').nth(1)).toHaveAttribute('data-level', 'stale');
  await expect(card.getByTestId('fleet-row').nth(1)).toContainText('47 days, 3 new CVEs');
  await card.getByRole('link', { name: 'all 9 projects' }).click();
  await expect(page).toHaveURL(/#\/$/);
});
