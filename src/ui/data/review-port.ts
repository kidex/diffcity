// The ReviewPort (ADR-028): what a screen gets to read and write review marks
// without knowing about the daemon. The SPA builds it from the API client and
// the SSE connection; the change screen renders from a Report alone and takes
// the port as optional (ADR-002). Nothing is computed here: progress,
// outdated flags and the summary all come from the daemon.

import type { Api, MarkRequest, ReviewState } from './api.js';
import type { Live, Unsubscribe } from './live.js';

export interface ReviewPort {
  /** The marks, note and progress now; null while the change has no snapshot. */
  load(signal?: AbortSignal): Promise<ReviewState | null>;
  mark(request: MarkRequest): ReturnType<Api['putMark']>;
  unmark(target: MarkRequest['target']): Promise<void>;
  setNote(note: string): Promise<{ note: string | null }>;
  /** The markdown summary of the "Needs rewrite" marks; null while there is no snapshot. */
  summary(signal?: AbortSignal): Promise<string | null>;
  /** Calls `listener` when the daemon says the marks of this change moved (a write, or a new snapshot); also after a reconnect. */
  onChange(listener: () => void): Unsubscribe;
}

/** The port of one change. */
export function createReviewPort(api: Api, live: Live, changeId: number): ReviewPort {
  return {
    load: (signal) => api.review(changeId, signal),
    mark: (request) => api.putMark(changeId, request),
    unmark: (target) => api.deleteMark(changeId, target),
    setNote: (note) => api.putNote(changeId, note),
    summary: (signal) => api.reviewSummary(changeId, signal),
    onChange(listener) {
      const stops = [
        live.on('hello', listener),
        live.on('review', (data) => {
          if (data.changeId === changeId) listener();
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
