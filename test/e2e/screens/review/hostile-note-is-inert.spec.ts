// e2e/review/hostile-note-is-inert (ADR-028): a rewrite note and the general
// note are the reviewer's own text, but they come back from the daemon and are
// shown in the tooltip, the file view's status line and the summary dialog.
// Markup and markdown in them must read as text: nothing runs, nothing is
// created from them.

import { test } from '@playwright/test';
import { SERVICE } from '../../support/hud.js';
import { panelReport } from '../../support/panel.js';
import { fileView, openReview, selectFile, summaryDialog } from '../../support/review.js';
import { seedMark } from '../../support/review-api.js';
import { project, sceneExpect as expect } from '../../support/scene.js';

test.describe.configure({ timeout: 90_000 });

const FILE_NOTE = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script> # heading [x](javascript:alert(1))';
const GENERAL_NOTE = '<img src=x onerror="window.pwned=3"> <script>window.pwned=4</script>\n# heading\n[x](javascript:alert(1))';

test('review/hostile-note-is-inert', async ({ page }) => {
  const report = panelReport();
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await openReview(page, {
    report,
    marks: [seedMark(report, 'file', SERVICE, 'rewrite', { note: FILE_NOTE })],
    note: GENERAL_NOTE,
  });

  const inert = async (root: string): Promise<void> => {
    const created = await page.evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(root)});
      return root === null ? -1 : root.querySelectorAll('img, script, a, h1, h2, h3, iframe, svg').length;
    })()`);
    // The summary's own markup has no such elements either: it is a <pre>.
    expect(created).toBe(0);
  };
  const clean = async (): Promise<void> => {
    expect(await page.evaluate('window.pwned === undefined')).toBe(true);
    expect(await page.evaluate(`document.querySelectorAll('img[src="x"], script:not([src])').length`)).toBe(
      await page.evaluate(`document.querySelectorAll('script:not([src])').length`),
    );
    expect(dialogs).toEqual([]);
  };

  // Tooltip.
  const point = await project(page, SERVICE);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByTestId('tip-mark-note')).toHaveText(FILE_NOTE);
  await inert('[data-testid="tooltip"]');
  await clean();

  // File view status line.
  await selectFile(page, SERVICE);
  await fileView(page).getByTestId('mark-scope-file').click();
  await expect(fileView(page).getByTestId('mark-note')).toHaveText(FILE_NOTE);
  await inert('[data-testid="file-view"] [data-testid="mark-bar"]');
  await clean();

  // Summary dialog: the markdown as text, the general note in the textarea.
  await page.getByTestId('review-summary').click();
  const dialog = summaryDialog(page);
  await expect(dialog.getByTestId('summary-text')).toContainText('# heading');
  await expect(dialog.getByTestId('summary-text')).toContainText('[x](javascript:alert(1))');
  await expect(dialog.getByTestId('summary-text')).toContainText('<script>window.pwned=4</script>');
  await expect(dialog.getByTestId('summary-note')).toHaveValue(GENERAL_NOTE);
  await inert('[data-testid="summary-dialog"] [data-testid="summary-text"]');
  await expect(dialog.locator('img, script, a')).toHaveCount(0);
  await clean();
});
