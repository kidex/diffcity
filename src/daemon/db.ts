// The daemon's single database connection (ADR-018: one writer, the main
// thread). Every plugin that needs the database calls getDb(context): the first
// call opens <home>/diffcity.db, later calls get the same Db. dbPlugin, listed
// first in src/daemon/plugins.ts, closes it on shutdown; plugins stop in reverse
// order, so every other plugin has stopped by then.
//
// src/core/db loads node:sqlite, so it is imported dynamically, after the
// ExperimentalWarning filter is installed (ADR-025, src/core/db/warning.ts).

import type { Db } from '../core/db/index.js';
import { suppressSqliteExperimentalWarning } from '../core/db/warning.js';
import type { DaemonContext, DaemonPlugin } from './plugin.js';

const opened = new WeakMap<DaemonContext, Promise<Db>>();

async function open(path: string): Promise<Db> {
  suppressSqliteExperimentalWarning();
  const { openDb } = await import('../core/db/index.js');
  return openDb(path);
}

/** The database of this daemon (context.paths.db), opened on the first call. A failed open is retried on the next call. */
export function getDb(context: DaemonContext): Promise<Db> {
  let db = opened.get(context);
  if (db === undefined) {
    db = open(context.paths.db);
    opened.set(context, db);
    db.catch(() => {
      opened.delete(context);
    });
  }
  return db;
}

/** Closes the database if it was opened; idempotent. */
export async function closeDb(context: DaemonContext): Promise<void> {
  const pending = opened.get(context);
  if (pending === undefined) return;
  opened.delete(context);
  const db = await pending.catch(() => null);
  db?.close();
}

/** Owns the connection's lifetime: list it before every plugin that calls getDb. */
export const dbPlugin: DaemonPlugin = {
  name: 'db',
  stop: (context) => closeDb(context),
};
