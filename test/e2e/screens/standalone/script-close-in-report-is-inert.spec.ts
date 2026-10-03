// e2e/standalone/script-close-in-report-is-inert (ADR-002): the Report is
// embedded in a JSON script element, so text from a repository or an agent that
// contains `</script>` or `<!--` must not end the element or start markup. The
// fixture escapes `<` as < (`embeddable`), which phase 5's export must
// reuse; the page renders, the text shows as text and nothing runs.

import { GUARD, finding } from '../../support/hud.js';
import { panelReport, tab } from '../../support/panel.js';
import { sceneExpect as expect } from '../../support/scene.js';
import { embeddable, test } from '../../support/standalone.js';

test.describe.configure({ timeout: 60_000 });

const CLOSE = '</script><script>window.__pwned=1</script>';
const COMMENT = '<!-- not a comment';

test('standalone/script-close-in-report-is-inert', async ({ page, standalone }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const report = panelReport();
  const guard = report.packages.flatMap((pkg) => pkg.files).find((file) => file.id === GUARD);
  if (guard === undefined) throw new Error('guard fixture file missing');
  guard.path = `src/auth/${CLOSE}${COMMENT}.ts`;
  report.findings = [finding('s-1', 'claude', guard.path, { title: `${CLOSE} title`, message: `${COMMENT} ${CLOSE}` })];
  // The fixture's escaping leaves no raw `<` in the embedded text.
  expect(embeddable(JSON.stringify(report))).not.toContain('<');

  await standalone.open(report);
  await expect(page.getByTestId('city')).toBeVisible();

  await tab(page, 'findings').click();
  const body = page.getByTestId('tab-findings-body');
  await expect(body).toContainText(`${CLOSE} title`);
  await expect(body).toContainText(`src/auth/${CLOSE}${COMMENT}.ts`);
  await expect(body).toContainText(`${COMMENT} ${CLOSE}`);
  // No script element was created from the text: none holds the payload except the data element.
  expect(await page.evaluate("[...document.scripts].filter((s) => s.id !== 'diffcity-report' && s.textContent.includes('__pwned')).length")).toBe(0);
  await expect(page.locator('#diffcity-report')).toHaveCount(1);
  expect(await page.evaluate('window.__pwned')).toBeUndefined();
});
