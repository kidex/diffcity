// e2e/review/outdated-shown-unchecked (SPEC.md section 6, "Review marks", plan
// question 3; ADR-028): a mark whose file or symbol changed in a newer snapshot
// is outdated. It counts as unchecked everywhere: the city draws it as not
// checked and the floor pulses again, the progress does not count it. The
// tooltip and the file view say "changed since you checked it" and keep the note.

import { test } from '@playwright/test';
import { effects, floorIndex } from '../../support/effects.js';
import { GUARD, SERVICE } from '../../support/hud.js';
import { panelReport, PLACE } from '../../support/panel.js';
import { card, cardButton, fileView, openReview, selectFile } from '../../support/review.js';
import { marksFromOverlay, seedMark } from '../../support/review-api.js';
import { project, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

const HINT = 'changed since you checked it';

test('review/outdated-shown-unchecked', async ({ page }) => {
  const report0 = panelReport();
  const { report } = await openReview(page, {
    report: report0,
    motion: 'no-preference',
    marks: [
      ...marksFromOverlay(report0, { files: { [GUARD]: 'outdated' } }),
      seedMark(report0, 'symbol', PLACE, 'rewrite', { state: 'outdated', note: 'Validate before the insert.' }),
    ],
  });

  // The city: the guard is not drawn checked, still pulses; no check mark, no notch for the service.
  const state = await effects(page);
  expect(state.checked[GUARD]).toBeUndefined();
  expect(state.pulse[GUARD]?.floors).toEqual([floorIndex(report, GUARD, 'OrderGuard.canPlace')]);
  expect(state.markers.filter((marker) => marker.kind === 'check' || marker.kind === 'notch' || marker.kind === 'rewrite')).toEqual([]);

  // The progress does not count them, and says how many went stale.
  await expect(page.getByTestId('progress-attention')).toHaveText('0 of 2 files that need your eyes checked');
  await expect(page.getByTestId('progress-outdated')).toHaveText('2 changed since you checked them');
  await expect(page.getByTestId('progress-rewrite')).toHaveText('0 to rewrite');

  // The tooltip over the guard: the old mark and why it no longer counts.
  const point = await project(page, GUARD);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByTestId('tip-mark-label')).toHaveText('Checked');
  await expect(page.getByTestId('tip-mark-outdated')).toHaveText(HINT);

  // The file view and the card: the same words, the note kept, the buttons not pressed.
  await selectFile(page, SERVICE, PLACE);
  await expect(fileView(page).getByTestId('mark-current')).toHaveText('Needs rewrite');
  await expect(fileView(page).getByTestId('mark-outdated')).toHaveText(HINT);
  await expect(fileView(page).getByTestId('mark-note')).toHaveText('Validate before the insert.');
  await expect(card(page).getByTestId('mark-outdated')).toHaveText(HINT);
  await expect(cardButton(page, 'rewrite')).toHaveAttribute('aria-pressed', 'false');
  // Undo is offered (it removes an outdated mark too); marking again makes it current.
  await expect(cardButton(page, 'undo')).toBeEnabled();
  await cardButton(page, 'good').click();
  await expect(card(page).getByTestId('mark-current')).toHaveText('Looks good');
  await expect(card(page).getByTestId('mark-outdated')).toHaveCount(0);
  await expect(page.getByTestId('progress-outdated')).toHaveText('1 changed since you checked it');
});
