// The FindingsPort (ADR-036): "Ask agent to fix" and "Mark as intended" (and
// its undo) on one change, without the screen knowing about the daemon. The
// SPA builds it from the API client; the change screen takes it as optional
// and the HTML export passes none (ADR-002). Nothing is decided here: the
// daemon resolves the finding, writes the fix queue or the state, and serves
// the Report with the new verdicts; the route refetches it.

import type { Api, FindingStateAnswer, FixAnswer } from './api.js';
import { ApiRequestError } from './api.js';

/** A request the daemon answered with an error (409 refusals, 404 `finding-not-found`, 403, ...): its code and the message to show. */
export interface FindingRefusal {
  code: string;
  message: string;
}

/** What an action got back: the daemon's answer, or its error. Only a request that got no answer (no daemon, a dropped connection) rejects. */
export type FindingAnswer<T> = { ok: true; value: T } | { ok: false; refusal: FindingRefusal };

/** The write guard refused the page's origin (403 `cross-site`): the page was opened from another address than the daemon's. */
export const CROSS_SITE = 'Open diffcity from the address `diffcity start` prints.';

export interface FindingsPort {
  /** "Ask agent to fix" on finding `key` (a `Finding.id`). */
  ask(key: string): Promise<FindingAnswer<FixAnswer>>;
  /** "Mark as intended" (`intended`) or its undo (`open`) on finding `key`. */
  setState(key: string, state: 'open' | 'intended'): Promise<FindingAnswer<FindingStateAnswer>>;
}

async function answer<T>(request: Promise<T>): Promise<FindingAnswer<T>> {
  try {
    return { ok: true, value: await request };
  } catch (error) {
    // Any answer of the daemon names its reason (fix-queue-unsafe, no-working-tree, finding-not-found, ...): the screen shows its message.
    if (error instanceof ApiRequestError) {
      const message = error.status === 403 && error.code === 'cross-site' ? CROSS_SITE : error.message;
      return { ok: false, refusal: { code: error.code, message } };
    }
    throw error;
  }
}

/**
 * The port of one change. `written` runs after every accepted write, so the
 * route can refetch the Report without waiting for the SSE `findings` signal.
 */
export function createFindingsPort(api: Api, changeId: number, written: () => void = () => undefined): FindingsPort {
  const then = <T>(result: FindingAnswer<T>): FindingAnswer<T> => {
    if (result.ok) written();
    return result;
  };
  return {
    ask: async (key) => then(await answer(api.fixFinding(changeId, key))),
    setState: async (key, state) => then(await answer(api.setFindingState(changeId, key, state))),
  };
}
