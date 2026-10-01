// The events table (ADR-018). A `collect` event is written only when a snapshot
// is created or replaced with a different hash; `collect` events older than the
// retention are pruned daily, the other types stay with their repo or change.

import type { Database } from 'better-sqlite3';
import type { EventRecord, EventType } from '../model/types.js';
import { isoTime, jsonOrNull, parseJsonOrNull, retentionCutoff } from './time.js';

interface EventRow {
  id: number;
  repoId: number;
  changeId: number | null;
  type: EventType;
  at: string;
  payload: string | null;
}

/** An event to record; `payload` is any JSON value, null for none. */
export type EventInput = Omit<EventRecord, 'id'>;

export interface EventStore {
  add(event: EventInput): EventRecord;
  /** Events of a repo (its changes included), latest first. */
  listForRepo(repoId: number): EventRecord[];
  /** Deletes `collect` events with `at` more than RETENTION_DAYS before `now`; returns how many. */
  pruneCollect(now: string): number;
}

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    repoId: row.repoId,
    changeId: row.changeId,
    type: row.type,
    at: row.at,
    payload: parseJsonOrNull(row.payload),
  };
}

export function createEventStore(db: Database): EventStore {
  const insert = db.prepare<[number, number | null, EventType, string, string | null], EventRow>(
    'INSERT INTO events (repoId, changeId, type, at, payload) VALUES (?, ?, ?, ?, ?) RETURNING *',
  );
  const forRepo = db.prepare<[number], EventRow>('SELECT * FROM events WHERE repoId = ? ORDER BY at DESC, id DESC');
  const prune = db.prepare<[string]>("DELETE FROM events WHERE type = 'collect' AND at < ?");

  return {
    add: (event) => {
      if (event.payload === undefined) throw new Error('event payload must be a JSON value or null');
      const row = insert.get(event.repoId, event.changeId, event.type, isoTime(event.at, 'at'), jsonOrNull(event.payload));
      if (row === undefined) throw new Error(`event for repo ${String(event.repoId)} was not inserted`);
      return toRecord(row);
    },
    listForRepo: (repoId) => forRepo.all(repoId).map(toRecord),
    pruneCollect: (now) => prune.run(retentionCutoff(now)).changes,
  };
}
