// e2e/a11y/landmarks-and-names (DC-89): no automated scanner is installed, so
// this checks the two things a scanner would flag first. Every visible
// button, link, field and control in the HUD, the reading panel, the file
// view, the review controls and the no-WebGL list has an accessible name
// (aria-label, aria-labelledby, an associated label, its text or its title),
// and the dialogs are role=dialog with aria-modal and a label.

import { expect, test, type Page } from '@playwright/test';
import { serveGuard } from '../../support/fileview.js';
import { GUARD, SERVICE } from '../../support/hud.js';
import { mockApi } from '../../support/mock-api.js';
import { panelReport } from '../../support/panel.js';
import { fileView, openReview, rewriteDialog, selectFile, summaryDialog, viewButton } from '../../support/review.js';
import { withoutWebgl } from '../../support/scene.js';

test.describe.configure({ timeout: 120_000 });

interface Unnamed {
  tag: string;
  testid: string | null;
  html: string;
}

/** Visible interactive elements under `scope` (a CSS selector) that have no accessible name; also the count scanned. */
async function scan(page: Page, scope: string): Promise<{ scanned: number; unnamed: Unnamed[] }> {
  return page.evaluate<{ scanned: number; unnamed: Unnamed[] }>(`((scope) => {
    const roots = Array.from(document.querySelectorAll(scope));
    const selector = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox], [role=switch], [role=option], [tabindex="0"]';
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && el.closest('[aria-hidden="true"]') === null;
    };
    const nameOf = (el) => {
      const label = el.getAttribute('aria-label');
      if (label && label.trim()) return label.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const text = by.split(/\\s+/).map((id) => (document.getElementById(id)?.textContent || '').trim()).join(' ').trim();
        if (text) return text;
      }
      if (el.labels && el.labels.length > 0) {
        const text = Array.from(el.labels).map((l) => (l.textContent || '').trim()).join(' ').trim();
        if (text) return text;
      }
      const clone = el.cloneNode(true);
      for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      const text = (clone.textContent || '').trim();
      if (text) return text;
      const title = el.getAttribute('title');
      return title && title.trim() ? title.trim() : '';
    };
    const seen = new Set();
    const unnamed = [];
    for (const root of roots) {
      const all = root.matches(selector) ? [root, ...root.querySelectorAll(selector)] : Array.from(root.querySelectorAll(selector));
      for (const el of all) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        if (nameOf(el) === '') unnamed.push({ tag: el.tagName.toLowerCase(), testid: el.getAttribute('data-testid'), html: el.outerHTML.slice(0, 160) });
      }
    }
    return { scanned: seen.size, unnamed };
  })(${JSON.stringify(scope)})`);
}

async function expectNamed(page: Page, scope: string, atLeast: number): Promise<void> {
  const { scanned, unnamed } = await scan(page, scope);
  expect(scanned, `${scope}: controls scanned`).toBeGreaterThanOrEqual(atLeast);
  expect(unnamed, `${scope}: controls without an accessible name`).toEqual([]);
}

async function expectModalDialog(dialog: ReturnType<Page['getByTestId']>): Promise<void> {
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const labelled = await dialog.getAttribute('aria-labelledby');
  const label = await dialog.getAttribute('aria-label');
  expect(labelled !== null || (label !== null && label.trim() !== ''), 'a dialog has aria-label or aria-labelledby').toBe(true);
  if (labelled !== null) {
    const text = await dialog.page().locator(`[id="${labelled}"]`).textContent();
    expect((text ?? '').trim(), 'the labelling element has text').not.toBe('');
  }
}

test('a11y/landmarks-and-names: the city screen (HUD, panel, file view, review controls, dialogs)', async ({ page }) => {
  await openReview(page);
  await selectFile(page, GUARD);

  await expectNamed(page, '[data-testid="hud-bar"]', 3);
  await expectNamed(page, '[data-testid="reading-panel"]', 3);
  await expectNamed(page, '[data-testid="selection-card"]', 2);
  await expect(fileView(page)).toBeVisible();
  await expectNamed(page, '[data-testid="file-view"]', 3);
  await expect(viewButton(page, 'checked')).toBeVisible();
  // The canvas is a named image, the filters are named groups.
  await expect(page.locator('canvas').first()).toHaveAttribute('role', 'img');
  await expect(page.locator('canvas').first()).toHaveAttribute('aria-label', /.+/);
  await expectNamed(page, 'header, nav', 1);

  // The dialogs.
  await page.keyboard.press('w');
  await expect(rewriteDialog(page)).toBeVisible();
  await expectModalDialog(rewriteDialog(page));
  await expectNamed(page, '[data-testid="rewrite-dialog"]', 3);
  await page.keyboard.press('Escape');
  await expect(rewriteDialog(page)).toBeHidden();

  await page.getByTestId('review-summary').click();
  await expect(summaryDialog(page)).toBeVisible();
  await expectModalDialog(summaryDialog(page));
  await expectNamed(page, '[data-testid="summary-dialog"]', 3);
});

test('a11y/landmarks-and-names: the no-WebGL list and the file view opened from it', async ({ page }) => {
  await withoutWebgl(page);
  await mockApi(page, { reports: { 11: panelReport() }, diff: serveGuard(), review: { marks: [] } });
  await page.goto('/#/change/11');
  await expect(page.getByTestId('touched-file').first()).toBeVisible();

  await expectNamed(page, '[data-testid="no-webgl"]', 4);
  // Every file button is named by its path.
  const buttons = page.getByTestId('touched-file').getByRole('button');
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < count; i += 1) await expect(buttons.nth(i)).toHaveAccessibleName(/\S+\/\S+|\S+\.\w+/);
  await expect(page.getByRole('button', { name: GUARD })).toBeVisible();
  await expect(page.getByRole('button', { name: SERVICE })).toBeVisible();

  await page.getByRole('button', { name: GUARD }).click();
  await expect(fileView(page)).toBeVisible();
  await expectNamed(page, '[data-testid="reading-panel"]', 3);
  await expect(viewButton(page, 'checked')).toBeVisible();
  await expectNamed(page, '[data-testid="file-view"]', 3);

  await page.keyboard.press('w');
  await expect(rewriteDialog(page)).toBeVisible();
  await expectModalDialog(rewriteDialog(page));
  await expectNamed(page, '[data-testid="rewrite-dialog"]', 3);
});
