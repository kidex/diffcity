// Storing an import's findings in the daemon (ADR-036): one transaction for
// the anchored batch and the `fixed` keys (FindingsStore.importBatch, which
// bumps the change's findings version, so the served Report's cache misses),
// then SSE `findings`. Parsing, anchoring and `fixedKeys` are src/core's; the
// `import` event and the socket handler belong to the import command.

import type { Db, FindingsImport, FindingsImportResult } from '../core/db/index.js';
import type { SseEvent } from '../core/model/types.js';

export interface FindingsWriteDeps {
  db: Db;
  broadcast: (event: SseEvent) => void;
}

export function storeFindingsImport(deps: FindingsWriteDeps, repoId: number, batch: FindingsImport): FindingsImportResult {
  const result = deps.db.findings.importBatch(batch);
  deps.broadcast({ event: 'findings', data: { repoId, changeId: batch.changeId } });
  return result;
}
