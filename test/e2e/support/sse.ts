// Plays the daemon's SSE side through the stub server (ADR-017): a spec tags
// its own streams with a cookie, then sends events to them only, so specs
// running in parallel never see each other's events.

import type { Page } from '@playwright/test';
import type { SseEventName, SseEventOf } from '../../../src/core/model/types.js';

/** Tags this page's SSE streams with `id` (the stub server reads the `e2e-client` cookie). */
export async function tagClient(page: Page, id: string): Promise<void> {
  await page.context().addCookies([{ name: 'e2e-client', value: id, domain: '127.0.0.1', path: '/' }]);
}

/** Sends `event` with `data` to the streams tagged `client`; returns how many streams got it. */
export async function emitSse<E extends SseEventName>(page: Page, client: string, event: E, data: SseEventOf<E>['data']): Promise<number> {
  const response = await page.request.post(`/__stub/sse/emit?event=${event}&client=${encodeURIComponent(client)}`, { data });
  return ((await response.json()) as { sent: number }).sent;
}
