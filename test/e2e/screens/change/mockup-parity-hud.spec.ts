// e2e/change/mockup-parity-hud: every HUD element of design/mockup.html is on
// the change screen, found by role and text: the top bar (breadcrumb, counters,
// the eyes badge, Export PlantUML and Approve), the title and its sentence,
// the verdict and type filter rows with "Show everything", the hint, the
// legend and the tooltip. The Fleet card needs a port and is covered by its
// own spec. Where the Night data city differs from the mockup, the difference
// is on purpose and listed in the task.

import { test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { GUARD } from '../../support/hud.js';
import { openCity, project, waitForCityAttribute, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 60_000 });

test('change/mockup-parity-hud', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await mockApi(page, { reports: { 11: fixtures.reportGolden() } });
  await openCity(page);

  // Top bar: brand, breadcrumb (repo, branch against base, commits and time).
  await expect(page.getByRole('link', { name: 'diffcity, all repos' })).toBeVisible();
  const crumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumb).toContainText('sample-shop');
  await expect(crumb).toContainText('feature/order-discounts');
  await expect(crumb.getByText('against')).toBeVisible();
  await expect(crumb.getByText('main', { exact: true })).toBeVisible();
  await expect(crumb).toContainText(/2 commits, \d+ days? ago/);
  // Counters: files, added, modified, signature, removed.
  const bar = page.getByRole('group', { name: 'Change summary' });
  for (const label of ['files', 'added', 'modified', 'signature', 'removed']) await expect(bar.locator('.stat small', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
  await expect(bar.getByText('2 files need your eyes before merge')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Export PlantUML' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Approve when tier 1 is read' })).toBeVisible();

  // Title and hint.
  await expect(page.getByRole('heading', { name: 'What the agent built' })).toBeVisible();
  await expect(page.getByText('Every block is a file, every floor a function. The label above each block is the review verdict. Filter by verdict or by kind of change.')).toBeVisible();
  const hint = page.getByTestId('hint');
  await expect(hint).toContainText('Drag to orbit, scroll to zoom');
  await expect(hint.getByText('R', { exact: true })).toBeVisible();
  await expect(hint).toContainText('reset view');

  // Filters: verdicts, change types, Show everything.
  const verdicts = page.getByRole('group', { name: 'Filter by verdict' });
  for (const label of ['Needs your eyes', 'Risky', 'Outside the spec', 'Reviewed, fine', 'Untouched']) await expect(verdicts.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  const types = page.getByRole('group', { name: 'Filter by change type' });
  for (const label of ['Added', 'Modified', 'Signature changed', 'Removed']) await expect(types.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  await expect(types.getByRole('button', { name: 'Show everything' })).toBeVisible();
  // No Rules row without rule findings; no Fleet card without a port.
  await expect(page.getByRole('group', { name: 'Filter by rule' })).toHaveCount(0);

  // Legend.
  const legend = page.getByRole('list', { name: 'Legend' });
  for (const label of ['needs your eyes', 'risky', 'outside the spec', 'reviewed, fine', 'added', 'modified', 'signature', 'removed', 'untouched']) await expect(legend).toContainText(label);
  await expect(page.getByTestId('legend-rule-x')).toBeHidden();

  // Tooltip on hover, with the mockup's fields.
  const guard = await project(page, GUARD);
  await page.mouse.move(guard.x, guard.y, { steps: 3 });
  await waitForCityAttribute(page, 'data-hovered', GUARD);
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('Needs your eyes');
  await expect(tip).toContainText('order.guard.ts');
  await expect(tip).toContainText('src/auth');
  await expect(tip).toContainText('added');
  await expect(tip).toContainText('modified');
  await expect(tip).toContainText('sig');
  await expect(tip).toContainText('removed');
  await expect(tip).toContainText('floor:');
});
