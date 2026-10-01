// Opening the diffcity database (ADR-018). Only the daemon's main thread opens
// it; workers and CLI commands never do, so there is a single writer.

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Connection } from './driver.js';
import { migrate, newerVersionMessage, SCHEMA_VERSION, userVersion } from './migrations.js';

/** Milliseconds a statement waits for a lock held by another connection. */
export const BUSY_TIMEOUT_MS = 5000;

/** The connection settings openDb applies, as SQLite reports them. */
export interface DbPragmas {
  journalMode: string;
  foreignKeys: boolean;
  busyTimeout: number;
  /** 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA. */
  synchronous: number;
}

/**
 * Opens (creating when missing) the SQLite file at `path`, applies the pragmas
 * from ADR-018 and migrates it to SCHEMA_VERSION. A database with a newer
 * schema is closed untouched and refused. The parent directory must exist
 * (ensureHome creates the diffcity home).
 */
export function openConnection(path: string): Connection {
  // node:sqlite would only say "unable to open database file".
  if (!existsSync(dirname(path))) throw new Error(`Cannot open database because the directory does not exist: ${path}`);
  const db = new Connection(path);
  try {
    db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    // Checked before WAL is switched on, so a newer database is left exactly as it was.
    const version = userVersion(db);
    if (version > SCHEMA_VERSION) throw new Error(newerVersionMessage(version));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // A no-op inside a transaction, so it is set before migrating.
    db.pragma('foreign_keys = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function readPragmas(db: Connection): DbPragmas {
  return {
    journalMode: String(db.pragma('journal_mode', { simple: true })),
    foreignKeys: Number(db.pragma('foreign_keys', { simple: true })) === 1,
    busyTimeout: Number(db.pragma('busy_timeout', { simple: true })),
    synchronous: Number(db.pragma('synchronous', { simple: true })),
  };
}
