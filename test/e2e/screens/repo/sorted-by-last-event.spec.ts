// e2e/repo/sorted-by-last-event (SPEC.md section 6): the rows are in the
// order the API sends them (last event first); the UI never re-sorts.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { shownChangeIds } from '../../support/repo.js';


test('rows follow the API order, latest event first', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  expect(await shownChangeIds(page)).toEqual(['11', '10', '12', '13', '14', '15']);
});

test('the UI keeps whatever order the API chose', async ({ page }) => {
  const detail = fixtures.repoMixedChanges();
  detail.changes.reverse();
  await mockApi(page, { details: [detail] });
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  expect(await shownChangeIds(page)).toEqual(['15', '14', '13', '12', '10', '11']);
});
