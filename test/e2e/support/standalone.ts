// The standalone page of the change screen (src/ui/standalone, ADR-002) for
// specs: the build in .tmp/standalone gets a generated copy of its index.html
// with a Report embedded, written beside the bundle so the relative asset
// paths work, and the page is opened from file://, with no server at all. The
// global setup builds the bundle (`npm run build:standalone`).

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test as base, type Page } from '@playwright/test';
import type { Report } from '../../../src/core/report/types.js';
import { waitReady } from './scene.js';

const BUILD_DIR = fileURLToPath(new URL('../../../.tmp/standalone/', import.meta.url));
const EMPTY_REPORT = '<script type="application/json" id="diffcity-report"></script>';

/** `json` as the text of a JSON script element: `<` is escaped so no `</script>` or `<!--` inside can end it. */
export const embeddable = (json: string): string => json.replaceAll('<', '\\u003c');

export interface StandalonePage {
  /** Opens a generated copy of the page with `report` (or the raw text `{ raw }`, for a malformed one) embedded; the city is awaited unless `waitForCity` is false. */
  open(report: Report | { raw: string }, options?: { waitForCity?: boolean; debug?: boolean }): Promise<void>;
}

export const test = base.extend<{ standalone: StandalonePage }>({
  standalone: async ({ page }, use) => {
    const written: string[] = [];
    await use({
      async open(report, { waitForCity = true, debug = true } = {}) {
        const index = `${BUILD_DIR}index.html`;
        if (!existsSync(index)) throw new Error('.tmp/standalone is not built: run `npm run build:standalone`');
        const html = readFileSync(index, 'utf8');
        if (!html.includes(EMPTY_REPORT)) throw new Error('the standalone index.html has no empty report element');
        const text = 'raw' in report ? report.raw : JSON.stringify(report);
        const file = `${BUILD_DIR}report-${randomUUID()}.html`;
        writeFileSync(file, html.replace(EMPTY_REPORT, () => `<script type="application/json" id="diffcity-report">${embeddable(text)}</script>`));
        written.push(file);
        // The debug hook is the screen's, read from the query string of a file URL as well.
        await page.goto(`${pathToFileURL(file).href}${debug ? '?scene-debug' : ''}`);
        if (waitForCity) await waitReady(page);
      },
    });
    for (const file of written) rmSync(file, { force: true });
  },
});

/** Every URL the page requests from now on, as strings (the array fills as requests are made). */
export function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.context().on('request', (request) => {
    urls.push(request.url());
  });
  return urls;
}
