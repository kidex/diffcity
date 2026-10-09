// e2e/session/report-alone (ADR-002, ADR-038): sessions are not part of the
// Report. The change screen rendered from a Report alone (the standalone page,
// which is the HTML export) has no SessionsPort, so it has no Session tab and
// asks for no sessions: the four tabs of the Report only.

import { sceneExpect as expect } from '../../support/scene.js';
import { panelReport } from '../../support/panel.js';
import { recordRequests, test } from '../../support/standalone.js';

test.describe.configure({ timeout: 90_000 });

test('session/report-alone/no-session-tab-in-report-alone', async ({ page, standalone }) => {
  const requests = recordRequests(page);
  await standalone.open(panelReport());
  await expect(page.getByTestId('reading-panel')).toBeVisible();
  await expect(page.getByTestId('panel-tabs').getByRole('button')).toHaveText([/^Execution order/, /^Findings/, /^Outside the spec/, /^Symbols/]);
  await expect(page.getByTestId('tab-session')).toHaveCount(0);
  await expect(page.getByTestId('tab-session-body')).toHaveCount(0);
  expect(requests.filter((url) => url.includes('/sessions'))).toEqual([]);
});
