// The DiffPort (ADR-026, ADR-027): what the change screen gets to read the diff
// of one file without knowing about the daemon. The SPA builds it from the API
// client; the screen renders from a Report alone and takes the port as
// optional (ADR-002). Nothing is computed here: rows, hunks, folds, symbol
// spans and highlights all come from the daemon.

import type { FileDiff } from '../../core/model/types.js';
import type { Api } from './api.js';

export interface DiffPort {
  /**
   * The diff of file `path` (a `File.id`) of the latest snapshot; with `symbolId`
   * (a `Symbol.id` of that file) the answer also carries `focus`. Rejects with
   * an ApiRequestError when the daemon refuses.
   */
  fileDiff(path: string, symbolId?: string, signal?: AbortSignal): Promise<FileDiff>;
}

/** The port of one change. */
export function createDiffPort(api: Api, changeId: number): DiffPort {
  return {
    fileDiff: (path, symbolId, signal) => api.diff(changeId, path, symbolId, signal),
  };
}
