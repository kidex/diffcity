// e2e/panel/findings-tab-grouping: the Findings tab lists every finding with
// its state, grouped by file: the change-level group first, then the files in
// the Report's order; within a group open findings come before fixed ones.

import { test } from '@playwright/test';
import { GUARD, SERVICE } from '../../support/hud.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { attributesOf, MAILER, openPanel, tab } from '../../support/panel.js';

test.describe.configure({ timeout: 60_000 });

test('panel/findings-tab-grouping', async ({ page }) => {
  await openPanel(page);
  await tab(page, 'findings').click();
  const groups = page.getByTestId('finding-group');
  await expect(groups).toHaveCount(4);
  expect(await attributesOf(page, 'finding-group', 'data-group')).toEqual(['change', GUARD, MAILER, SERVICE]);

  // Change-level first, labelled as the whole change, not as a file.
  await expect(groups.first().getByTestId('group-change')).toHaveText('Whole change');
  await expect(groups.first().getByTestId('finding')).toHaveCount(1);
  await expect(groups.first()).toContainText('Scope is wider than asked');

  // A file's group names the file, its package and its verdict.
  const guard = groups.nth(1);
  await expect(guard.getByTestId('group-file')).toContainText(GUARD);
  await expect(guard.getByTestId('group-file')).toContainText('src/auth');
  await expect(guard.getByTestId('group-file')).toContainText('Needs your eyes');

  // Open first, the fixed one last, with its state shown.
  const service = groups.nth(3).getByTestId('finding');
  await expect(service).toHaveCount(2);
  await expect(service.nth(0)).toHaveAttribute('data-state', 'open');
  await expect(service.nth(0)).toContainText('Total is not rounded');
  await expect(service.nth(1)).toHaveAttribute('data-state', 'fixed');
  await expect(service.nth(1).getByTestId('finding-state')).toHaveText('fixed');
  await expect(service.nth(1).getByTestId('finding-source')).toHaveText('eslint');
});
