// A page shared by the specs of one file that all read the same large city
// (the `large` preset): the first frame of 20,000 floors on SwiftShader takes
// seconds, so a file opens it once and its tests read it, instead of each
// paying for a new context. Use it in `test.describe.serial`.

import type { Browser, Page, TestInfo } from '@playwright/test';
import type { Report } from '../../../src/core/report/types.js';
import { fixtures, mockApi } from './mock-api.js';
import { CITY_TIMEOUT, openCity } from './scene.js';
import { emitSse, tagClient } from './sse.js';

/**
 * Test timeout of a spec that reads the large city: its first frame, the quality probe and every wait on the scene
 * each take up to CITY_TIMEOUT on a loaded SwiftShader runner, and a test makes several of them in a row.
 */
export const LARGE_CITY_TEST_TIMEOUT = CITY_TIMEOUT * 8;

export interface LargeCity {
  page: Page;
  report: Report;
  /** Sends a new Report of the change to the open page (over the stub server's SSE stream) and waits for it to be on show. */
  push(next: Report): Promise<void>;
  close(): Promise<void>;
}

/** Opens the large city in its own context. Call in `beforeAll` (give it a long timeout). */
export async function openLargeCity(browser: Browser, testInfo: TestInfo, reducedMotion: 'reduce' | 'no-preference'): Promise<LargeCity> {
  const baseURL = testInfo.project.use.baseURL;
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1440, height: 900 }, reducedMotion });
  const page = await context.newPage();
  const report = fixtures.reportLargeCity();
  const reports: Record<number, Report> = { 11: report };
  await mockApi(page, { reports });
  await tagClient(page, testInfo.testId);
  await openCity(page);
  return {
    page,
    report,
    async push(next) {
      reports[11] = next;
      await emitSse(page, testInfo.testId, 'snapshot', { repoId: 1, changeId: 11, head: '9c1e5a7' });
    },
    close: () => context.close(),
  };
}
