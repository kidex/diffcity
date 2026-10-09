// The SessionsPort (ADR-038): the Claude Code sessions linked to one change,
// for the Session tab of the reading panel, without the screen knowing about
// the daemon. The SPA builds it from the API client and the SSE connection;
// the change screen takes it as optional and the HTML export passes none
// (ADR-002): sessions are never part of the Report. Nothing is decided here:
// which runs are shown, `here`, `stale` and `unreadable` all come from the
// daemon.

import type { SessionsResponse } from '../../core/model/types.js';
import type { Api } from './api.js';
import { ApiRequestError } from './api.js';
import type { Coalescer, Live, Unsubscribe } from './live.js';

export interface SessionsPort {
  /**
   * The sessions linked to the change now, newest first. Null when the daemon
   * refuses to give them (an unknown change, a cross-site page): the tab stays
   * hidden. Rejects on any other failure (no answer, a daemon error): what
   * is on screen stays.
   */
  load(signal?: AbortSignal): Promise<SessionsResponse | null>;
  /** Calls `listener` when the daemon stored a new read of a session of this change (SSE `sessions`), and after a reconnect. */
  onChange(listener: () => void): Unsubscribe;
}

/** The port of one change; with `refetch`, a burst of events reloads at most once per 250 ms. */
export function createSessionsPort(api: Api, live: Live, changeId: number, refetch?: Coalescer): SessionsPort {
  const key = `sessions:${String(changeId)}`;
  return {
    async load(signal) {
      try {
        return await api.sessions(changeId, signal);
      } catch (error) {
        if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
    },
    onChange(listener) {
      const fire = (): void => {
        if (refetch === undefined) listener();
        else refetch.request(key, listener);
      };
      const stops = [
        live.on('hello', fire),
        live.on('sessions', (data) => {
          if (data.changeId === changeId) fire();
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
