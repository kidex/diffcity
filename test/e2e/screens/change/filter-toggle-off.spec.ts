// e2e/change/filter-toggle-off (ADR-026): clicking the active chip of a row
// turns that row off and nothing else; the city is whole again when no row is on.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { paintDump } from '../../support/hud.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/filter-toggle-off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);
  const city = page.getByTestId('city');
  const verdict = page.getByRole('group', { name: 'Filter by verdict' }).getByRole('button', { name: /^Risky/ });
  const type = page.getByRole('group', { name: 'Filter by change type' }).getByRole('button', { name: /^Modified/ });

  await verdict.click();
  await type.click();
  await expect(city).toHaveAttribute('data-filters', 'verdict=risky;type=mod;rule=');

  // Turning the verdict row off leaves the type row on.
  await verdict.click();
  await expect(verdict).toHaveAttribute('aria-pressed', 'false');
  await expect(type).toHaveAttribute('aria-pressed', 'true');
  await expect(city).toHaveAttribute('data-filters', 'verdict=;type=mod;rule=');
  expect((await paintDump(page)).dimmed.length).toBeGreaterThan(0);

  await type.click();
  await expect(type).toHaveAttribute('aria-pressed', 'false');
  await expect(city).toHaveAttribute('data-filters', 'verdict=;type=;rule=');
  await expect.poll(async () => (await paintDump(page)).dimmed).toEqual([]);
  await expect(page.locator('[data-testid="roof-label"].is-dim')).toHaveCount(0);

  // The keyboard turns a chip on and off too.
  await verdict.focus();
  await page.keyboard.press('Enter');
  await expect(verdict).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(verdict).toHaveAttribute('aria-pressed', 'false');
});
