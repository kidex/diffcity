// Reads for the Repo screen specs.

import type { Page } from '@playwright/test';

/** The change ids of the rows on screen, top to bottom. */
export async function shownChangeIds(page: Page): Promise<string[]> {
  const rows = await page.getByTestId('change-row').all();
  return Promise.all(rows.map(async (row) => (await row.getAttribute('data-change-id')) ?? ''));
}
