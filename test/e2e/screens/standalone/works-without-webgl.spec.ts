// e2e/standalone/works-without-webgl (ADR-002): without WebGL the standalone
// page lists the touched files of the embedded Report instead of the city, and
// still no request leaves the page.

import { panelReport } from '../../support/panel.js';
import { withoutWebgl, sceneExpect as expect } from '../../support/scene.js';
import { recordRequests, test } from '../../support/standalone.js';

test('standalone/works-without-webgl', async ({ page, standalone }) => {
  await withoutWebgl(page);
  const urls = recordRequests(page);
  const report = panelReport();
  await standalone.open(report, { waitForCity: false, debug: false });

  await expect(page.getByTestId('no-webgl-note')).toHaveText('3D view needs WebGL');
  await expect(page.getByTestId('city')).toHaveCount(0);
  const touched = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same');
  await expect(page.getByTestId('touched-file')).toHaveCount(touched.length);
  await expect(page.getByTestId('touched-file').first()).toBeVisible();

  const leaving = urls.filter((raw) => !['file:', 'data:', 'blob:'].includes(new URL(raw).protocol));
  expect(leaving).toEqual([]);
});
