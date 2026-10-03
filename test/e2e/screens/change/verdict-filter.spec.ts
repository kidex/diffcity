// e2e/change/verdict-filter (ADR-026): row 1 of the filters has a chip per
// verdict with its counter from the summary; choosing one dims the buildings
// of the other verdicts (and their roof labels), choosing it again turns the
// filter off. Asserted through the scene's state, not pixels.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { paintDump } from '../../support/hud.js';
import { openCity, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/verdict-filter', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = fixtures.reportGolden();
  await mockApi(page, { reports: { 11: report } });
  await openCity(page);

  const row = page.getByRole('group', { name: 'Filter by verdict' });
  const files = report.packages.flatMap((pkg) => pkg.files);
  const labels = { eyes: 'Needs your eyes', risky: 'Risky', spec: 'Outside the spec', ok: 'Reviewed, fine', same: 'Untouched' } as const;
  for (const [verdict, label] of Object.entries(labels)) {
    const chip = row.getByRole('button', { name: new RegExp(`^${label}`) });
    await expect(chip).toHaveText(`${label}${String(report.summary.byVerdict[verdict as keyof typeof labels])}`);
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  }
  expect((await paintDump(page)).dimmed).toEqual([]);

  const eyes = row.getByRole('button', { name: /^Needs your eyes/ });
  await eyes.click();
  await expect(eyes).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=eyes;type=;rule=');
  const others = files.filter((file) => file.verdict !== 'eyes').map((file) => file.id);
  expect((await paintDump(page)).dimmed.sort()).toEqual(others.sort());
  // The labels of dimmed buildings fade; the eyes buildings keep theirs.
  await expect(page.locator('[data-testid="roof-label"].v-eyes.is-dim')).toHaveCount(0);
  await expect(page.locator('[data-testid="roof-label"].v-ok.is-dim').first()).toBeAttached();

  // Another verdict replaces it.
  const ok = row.getByRole('button', { name: /^Reviewed, fine/ });
  await ok.click();
  await expect(ok).toHaveAttribute('aria-pressed', 'true');
  await expect(eyes).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await paintDump(page)).dimmed.length).toBe(files.filter((file) => file.verdict !== 'ok').length);

  // The active chip again: off.
  await ok.click();
  await expect(ok).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', 'verdict=;type=;rule=');
  await expect.poll(async () => (await paintDump(page)).dimmed).toEqual([]);
});
