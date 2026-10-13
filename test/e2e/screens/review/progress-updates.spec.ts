// e2e/review/progress-updates (SPEC.md section 6, "Review marks"; ADR-028): the
// top bar says "N of M files that need your eyes checked" with the touched and
// rewrite counts, all from the daemon's progress; it follows every mark and
// undo, says "Everything that needs your eyes is checked" at the end, and
// counts marks that went outdated.

import { test } from '@playwright/test';
import { GUARD, MIGRATION } from '../../support/hud.js';
import { CAN_PLACE } from '../../support/panel.js';
import { expectProgress, openReview, progress, selectFile } from '../../support/review.js';
import { sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

test('review/progress-updates', async ({ page }) => {
  await openReview(page);
  await expectProgress(page, '0 of 2 files that need your eyes checked');
  await expect(page.getByTestId('progress-touched')).toHaveText('0 of 11 touched files checked');
  await expect(page.getByTestId('progress-rewrite')).toHaveText('0 to rewrite');
  await expect(page.getByTestId('progress-outdated')).toHaveCount(0);
  await expect(page.getByTestId('progress-bar')).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByTestId('progress-bar')).toHaveAttribute('aria-valuemax', '2');

  // The guard's only changed floor: marking it completes the file.
  await selectFile(page, GUARD, CAN_PLACE);
  await page.keyboard.press('c');
  await expectProgress(page, '1 of 2 files that need your eyes checked');
  await expect(page.getByTestId('progress-touched')).toHaveText('1 of 11 touched files checked');
  await expect(page.getByTestId('progress-bar')).toHaveAttribute('aria-valuenow', '1');

  // The migration file as a whole: everything that needs eyes is done.
  await selectFile(page, MIGRATION);
  await page.getByTestId('selection-card').getByTestId('mark-scope-file').click();
  await page.keyboard.press('g');
  await expectProgress(page, 'Everything that needs your eyes is checked');
  await expect(progress(page)).toHaveClass(/\bdone\b/);
  await expect(page.getByTestId('progress-touched')).toHaveText('2 of 11 touched files checked');

  // A rewrite (W, no note asked) counts as marked, and as a rewrite; undo takes the file out again.
  await selectFile(page, GUARD, CAN_PLACE);
  await page.keyboard.press('w');
  await expect(page.getByTestId('progress-rewrite')).toHaveText('1 to rewrite');
  await expectProgress(page, 'Everything that needs your eyes is checked');
  await page.keyboard.press('u');
  await expectProgress(page, '1 of 2 files that need your eyes checked');
  await expect(page.getByTestId('progress-rewrite')).toHaveText('0 to rewrite');
  await expect(progress(page)).not.toHaveClass(/\bdone\b/);
});
