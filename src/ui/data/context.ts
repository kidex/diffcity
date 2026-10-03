// What the daemon-backed screens (Fleet, Repo) and the shell receive from the
// app. The change screen never gets it (ADR-002, ADR-022).

import type { Api } from './api.js';
import type { Coalescer, Live } from './live.js';
import type { ReviewPort } from './review-port.js';

export interface DataContext {
  api: Api;
  live: Live;
  /** Refetches coalesced per resource key (ADR-017: one per 250 ms). */
  refetch: Coalescer;
  /** The review port of a change (ADR-028); handed to the change screen once it takes one. */
  review(changeId: number): ReviewPort;
}
