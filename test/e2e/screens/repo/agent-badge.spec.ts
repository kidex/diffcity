// e2e/repo/agent-badge (SPEC.md section 3a, C3): a change an agent worked on
// and nobody reviewed carries "Agent worked, not reviewed", from the
// daemon's `agentUnreviewed`.

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';

test('only the agent-unreviewed change has the badge', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.getByTestId('agent-badge')).toHaveCount(1);
  await expect(page.locator('[data-change-id="11"]').getByTestId('agent-badge')).toHaveText('Agent worked, not reviewed');
});

test('the badge follows the flag, not the last event type', async ({ page }) => {
  const detail = fixtures.repoMixedChanges();
  detail.changes = detail.changes.map((change) => (change.id === 11 ? { ...change, agentUnreviewed: false } : change));
  await mockApi(page, { details: [detail] });
  await page.goto('/#/repo/1');
  await expect(page.getByTestId('change-row')).toHaveCount(6);
  await expect(page.getByTestId('agent-badge')).toHaveCount(0);
});
