// e2e/panel/works-without-webgl: without WebGL the change screen renders the
// fallback list of touched files instead of the city. The reading panel is
// part of the city view and is not mounted; the page stays inert and quiet:
// no console error or page error, and J/K/Esc do nothing and do not throw.

import { expect, test } from '@playwright/test';
import { mockApi } from '../../support/mock-api.js';
import { withoutWebgl } from '../../support/scene.js';
import { panelReport } from '../../support/panel.js';

test('panel/works-without-webgl', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // three.js reports the context it could not create; the screen catches it and falls back.
    if (message.type() === 'error' && !message.text().includes('Error creating WebGL context')) errors.push(message.text());
  });
  await withoutWebgl(page);
  // The review routes answer (a change with no marks), as the daemon's do for a change with a snapshot.
  await mockApi(page, { reports: { 11: panelReport() }, review: {} });
  await page.goto('/#/change/11');

  await expect(page.getByTestId('no-webgl-note')).toHaveText('3D view needs WebGL');
  await expect(page.getByTestId('touched-file').first()).toBeVisible();
  await expect(page.getByTestId('reading-panel')).toHaveCount(0);

  for (const key of ['j', 'k', 'J', 'K', 'Escape']) await page.keyboard.press(key);
  await expect(page.getByTestId('no-webgl-note')).toBeVisible();
  await expect(page.getByTestId('touched-file').first()).toBeVisible();
  expect(errors).toEqual([]);
});
