// Storing an import's findings in the daemon (ADR-036): one transaction for
// the anchored batch, the `fixed` keys (FindingsStore.importBatch, which
// bumps the change's findings version, so the served Report's cache misses)
// and, for `diffcity import`, its `import` event; then SSE `findings` (the
// change's Report moved), `changes` (its listed verdict counts moved) and
// `repo` (the repo's highFindings moved, so Fleet reloads; DC-106), as the
// findings state route sends them.
// Parsing, anchoring and `fixedKeys` are src/core's; the socket handler is
// src/daemon/collector/import.ts.

import type { Db, FindingsImport, FindingsImportResult } from '../core/db/index.js';
import type { SseEvent } from '../core/model/types.js';

export interface FindingsWriteDeps {
  db: Db;
  broadcast: (event: SseEvent) => void;
}

/** The `import` event written with the batch (`at` is the batch's); its payload is built from what was stored. */
export interface ImportEventInput {
  payload: (stored: FindingsImportResult) => Record<string, unknown>;
}

export function storeFindingsImport(deps: FindingsWriteDeps, repoId: number, batch: FindingsImport, event?: ImportEventInput): FindingsImportResult {
  const { db } = deps;
  const result = db.transaction(() => {
    const stored = db.findings.importBatch(batch);
    if (event !== undefined) db.events.add({ repoId, changeId: batch.changeId, type: 'import', at: batch.at, payload: event.payload(stored) });
    return stored;
  });
  deps.broadcast({ event: 'findings', data: { repoId, changeId: batch.changeId } });
  deps.broadcast({ event: 'changes', data: { repoId } });
  deps.broadcast({ event: 'repo', data: { repoId } });
  return result;
}
