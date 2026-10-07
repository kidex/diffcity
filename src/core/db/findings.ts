// The findings table (ADR-036, schema v3). Two kinds of rows:
//
// - `origin = 'import'`: an imported finding, keyed by its finding key; the
//   serialized Finding, its anchor (symbol name, kind, first line and
//   fingerprint at import) and its state. Returned in import order, which the
//   dedup of the overlay depends on.
// - `origin = 'rule-state'`: only `{ key, state }` for a rule finding the user
//   marked as intended, keyed by the rule finding's id, so the state survives
//   snapshots (rule findings are recomputed each snapshot).
//
// Rows go with their change (ON DELETE CASCADE). Each write bumps the change's
// findings version, the second half of the served Report's cache key; the
// version is per process, like the cache it keys. Written only by the daemon's
// main thread.

import type { Finding } from '../report/types.js';
import type { FindingState, StoredFinding } from '../findings/types.js';
import type { Connection } from './driver.js';
import { isoTime } from './time.js';

interface FindingRow {
  key: string;
  head: string;
  finding: string;
  state: FindingState;
  anchorFingerprint: string | null;
  alias: string | null;
  why: string | null;
  symbolName: string | null;
  symbolKind: NonNullable<StoredFinding['anchor']['symbolKind']> | null;
  symbolStart: number | null;
}

/** A batch of anchored findings from one import, and the keys the import closes (`fixedKeys`). */
export interface FindingsImport {
  changeId: number;
  /** The head of the snapshot the findings were anchored on; kept in `findings.head`. */
  head: string;
  /** In import order. A key already stored is merged into its row (see importBatch). */
  findings: readonly StoredFinding[];
  /** Keys of stored `open` findings that become `fixed`. */
  fixed: readonly string[];
  at: string;
}

export interface FindingsImportResult {
  inserted: number;
  updated: number;
  /** Stored findings set to `fixed`. */
  fixed: number;
  /** The change's findings version after the import. */
  version: number;
}

export interface FindingsStore {
  /** The imported findings of a change, in import order, with the stored state. */
  list(changeId: number): StoredFinding[];
  /** One imported finding by key, or null. */
  get(changeId: number, key: string): StoredFinding | null;
  /** The states set on rule findings, keyed by rule finding id. */
  ruleStates(changeId: number): Record<string, FindingState>;
  /** Whether the change has any imported finding or rule state (the served Report then differs from the stored one). */
  hasAny(changeId: number): boolean;
  /** The change's findings version: 0 before any write in this process, then a new value after each write. */
  version(changeId: number): number;
  /**
   * Inserts or merges a batch in one transaction, then sets the `fixed` keys.
   * A key already stored takes the new finding, head and anchor, keeps its
   * first `importedAt` (its place in import order) and an alias or why it had
   * when the new one has none; its state becomes the imported one, except that
   * `intended` (the user's decision) is kept. Only `open` rows become `fixed`.
   */
  importBatch(batch: FindingsImport): FindingsImportResult;
  /** Sets the state of imported findings; returns how many rows changed. */
  setStates(changeId: number, keys: readonly string[], state: FindingState, at: string): number;
  /** `intended` writes the rule-state row of a rule finding; `open` removes it (open is the default). */
  setRuleState(changeId: number, id: string, head: string, state: 'open' | 'intended', at: string): void;
}

function toStored(row: FindingRow): StoredFinding {
  const parsed = JSON.parse(row.finding) as Finding;
  return {
    key: row.key,
    ...(row.alias === null ? {} : { alias: row.alias }),
    ...(row.why === null ? {} : { why: row.why }),
    finding: { ...parsed, id: row.key, state: row.state },
    anchor: {
      ...(row.symbolName === null ? {} : { symbolName: row.symbolName }),
      ...(row.symbolKind === null ? {} : { symbolKind: row.symbolKind }),
      ...(row.symbolStart === null ? {} : { symbolStart: row.symbolStart }),
      fingerprint: row.anchorFingerprint,
    },
  };
}

const COLUMNS = 'key, head, finding, state, anchorFingerprint, alias, why, symbolName, symbolKind, symbolStart';

/** The process-wide sequence the versions are drawn from, so a version never repeats, even for a reused change id. */
let sequence = 0;

export function createFindingsStore(db: Connection): FindingsStore {
  const versions = new Map<number, number>();
  const bump = (changeId: number): number => {
    sequence += 1;
    versions.set(changeId, sequence);
    return sequence;
  };

  const list = db.prepare<[number], FindingRow>(
    `SELECT ${COLUMNS} FROM findings WHERE changeId = ? AND origin = 'import' AND key IS NOT NULL ORDER BY importedAt, id`,
  );
  const get = db.prepare<[number, string], FindingRow>(
    `SELECT ${COLUMNS} FROM findings WHERE changeId = ? AND key = ? AND origin = 'import'`,
  );
  const ruleStates = db.prepare<[number], { key: string; state: FindingState }>(
    "SELECT key, state FROM findings WHERE changeId = ? AND origin = 'rule-state' AND key IS NOT NULL ORDER BY id",
  );
  const any = db.prepare<[number], { one: number }>('SELECT 1 AS one FROM findings WHERE changeId = ? AND key IS NOT NULL LIMIT 1');
  const exists = db.prepare<[number, string], { origin: string }>('SELECT origin FROM findings WHERE changeId = ? AND key = ?');
  const upsert = db.prepare<
    [number, string, string, string, string, string | null, string | null, string | null, string | null, string | null, number | null, string, string]
  >(
    `INSERT INTO findings
       (changeId, key, origin, head, finding, state, anchorFingerprint, alias, why, symbolName, symbolKind, symbolStart, importedAt, updatedAt)
     VALUES (?, ?, 'import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (changeId, key) DO UPDATE SET
       head = excluded.head, finding = excluded.finding,
       state = CASE WHEN findings.state = 'intended' THEN 'intended' ELSE excluded.state END,
       anchorFingerprint = excluded.anchorFingerprint,
       alias = COALESCE(excluded.alias, findings.alias), why = COALESCE(excluded.why, findings.why),
       symbolName = excluded.symbolName, symbolKind = excluded.symbolKind, symbolStart = excluded.symbolStart,
       updatedAt = excluded.updatedAt
     WHERE findings.origin = 'import'`,
  );
  const fix = db.prepare<[string, number, string]>(
    "UPDATE findings SET state = 'fixed', updatedAt = ? WHERE changeId = ? AND key = ? AND origin = 'import' AND state = 'open'",
  );
  const setState = db.prepare<[string, string, number, string]>(
    "UPDATE findings SET state = ?, updatedAt = ? WHERE changeId = ? AND key = ? AND origin = 'import'",
  );
  const putRuleState = db.prepare<[number, string, string, string, string, string, string]>(
    `INSERT INTO findings (changeId, key, origin, head, finding, state, importedAt, updatedAt)
     VALUES (?, ?, 'rule-state', ?, ?, ?, ?, ?)
     ON CONFLICT (changeId, key) DO UPDATE SET head = excluded.head, state = excluded.state, updatedAt = excluded.updatedAt
     WHERE findings.origin = 'rule-state'`,
  );
  const removeRuleState = db.prepare<[number, string]>("DELETE FROM findings WHERE changeId = ? AND key = ? AND origin = 'rule-state'");

  const importBatch = (batch: FindingsImport): FindingsImportResult => {
    const at = isoTime(batch.at, 'at');
    let inserted = 0;
    let updated = 0;
    let fixed = 0;
    for (const entry of batch.findings) {
      if (entry.finding.id !== entry.key) throw new Error(`finding ${entry.key} has id ${entry.finding.id}`);
      const before = exists.get(batch.changeId, entry.key);
      if (before !== undefined && before.origin !== 'import') throw new Error(`key ${entry.key} is not an imported finding`);
      const { anchor } = entry;
      upsert.run(
        batch.changeId,
        entry.key,
        batch.head,
        JSON.stringify(entry.finding),
        entry.finding.state,
        anchor.fingerprint,
        entry.alias ?? null,
        entry.why ?? null,
        anchor.symbolName ?? null,
        anchor.symbolKind ?? null,
        anchor.symbolStart ?? null,
        at,
        at,
      );
      if (before === undefined) inserted += 1;
      else updated += 1;
    }
    for (const key of batch.fixed) fixed += fix.run(at, batch.changeId, key).changes;
    return { inserted, updated, fixed, version: 0 };
  };

  return {
    list: (changeId) => list.all(changeId).map(toStored),
    get: (changeId, key) => {
      const row = get.get(changeId, key);
      return row === undefined ? null : toStored(row);
    },
    ruleStates: (changeId) => Object.fromEntries(ruleStates.all(changeId).map((row) => [row.key, row.state])),
    hasAny: (changeId) => any.get(changeId) !== undefined,
    version: (changeId) => versions.get(changeId) ?? 0,
    importBatch: (batch) => {
      const result = db.transaction(() => importBatch(batch), { immediate: true });
      return { ...result, version: bump(batch.changeId) };
    },
    setStates: (changeId, keys, state, at) => {
      const when = isoTime(at, 'at');
      const changed = db.transaction(() => keys.reduce((n, key) => n + setState.run(state, when, changeId, key).changes, 0), { immediate: true });
      if (changed > 0) bump(changeId);
      return changed;
    },
    setRuleState: (changeId, id, head, state, at) => {
      const when = isoTime(at, 'at');
      if (state === 'intended') putRuleState.run(changeId, id, head, JSON.stringify({ id, state }), state, when, when);
      else removeRuleState.run(changeId, id);
      bump(changeId);
    },
  };
}
