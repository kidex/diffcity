// What the daemon-backed screens (Fleet, Repo) and the shell receive from the
// app. The change screen never gets it (ADR-002, ADR-022).

import type { Api } from './api.js';
import type { Coalescer, Live } from './live.js';

export interface DataContext {
  api: Api;
  live: Live;
  /** Refetches coalesced per resource key (ADR-017: one per 250 ms). */
  refetch: Coalescer;
}
