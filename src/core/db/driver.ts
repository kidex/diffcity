// The SQLite driver (ADR-025): a thin typed layer over Node's built-in
// node:sqlite. This is the only file that imports node:sqlite; the stores and
// openDb go through Connection. Loading it on Node 22 emits a one-line
// ExperimentalWarning; see warning.ts for the daemon's filter.

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** A value SQLite can bind: node:sqlite rejects booleans and undefined. */
export type BindValue = number | bigint | string | Uint8Array | null;

export interface RunResult {
  /** Rows changed; a number (node:sqlite gives a bigint only with readBigInts). */
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * A prepared statement taking positional parameters `P` and returning rows `R`.
 * Rows are objects with a null prototype, keyed by column name; integers come
 * back as numbers.
 */
export interface Statement<P extends BindValue[] = BindValue[], R = unknown> {
  run(...params: P): RunResult;
  get(...params: P): R | undefined;
  all(...params: P): R[];
}

export interface ConnectionOptions {
  /** Opens the file read-only; it must exist. */
  readOnly?: boolean;
}

export interface TransactionOptions {
  /**
   * BEGIN IMMEDIATE: take the write lock up front, waiting up to busy_timeout.
   * Every write transaction needs it: a deferred one that reads and then writes
   * upgrades its lock without the busy handler and fails with SQLITE_BUSY at
   * once when another connection writes (DC-39). Ignored when nested.
   */
  immediate?: boolean;
}

/** One SQLite connection. Not shared across threads. */
export class Connection {
  readonly path: string;
  readonly #db: DatabaseSync;
  /** Open transaction levels: 0 none, 1 BEGIN, n > 1 savepoints. */
  #depth = 0;

  constructor(path: string, options: ConnectionOptions = {}) {
    this.path = path;
    this.#db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  prepare<P extends BindValue[] = BindValue[], R = unknown>(sql: string): Statement<P, R> {
    const statement = this.#db.prepare(sql);
    // The row types are the caller's declaration of the SELECT; node:sqlite types rows as records of SQL values.
    return {
      run: (...params) => {
        const result = statement.run(...(params as SQLInputValue[]));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      get: (...params) => statement.get(...(params as SQLInputValue[])) as R | undefined,
      all: (...params) => statement.all(...(params as SQLInputValue[])) as R[],
    };
  }

  /** Runs SQL text, possibly several statements, without results. Not named exec, which the ADR-012 process-call scan flags. */
  execScript(sql: string): void {
    this.#db.exec(sql);
  }

  /**
   * Runs `PRAGMA <source>` (`source` is code, never user input) and returns its
   * rows; with `simple`, the first column of the first row (undefined when none).
   */
  pragma(source: string, options: { simple: true }): unknown;
  pragma(source: string, options?: { simple?: false }): unknown[];
  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.#db.prepare(`PRAGMA ${source}`).all();
    if (options.simple !== true) return rows;
    const first = rows[0];
    return first === undefined ? undefined : Object.values(first)[0];
  }

  /**
   * Runs `fn` in a transaction and returns its result: BEGIN (or BEGIN
   * IMMEDIATE) at the outermost level, a SAVEPOINT when nested. Commits when
   * `fn` returns, rolls back and rethrows when it throws. `fn` must be
   * synchronous.
   */
  transaction<T>(fn: () => T, options: TransactionOptions = {}): T {
    const outermost = this.#depth === 0;
    const savepoint = `dc_sp_${String(this.#depth)}`;
    this.#db.exec(outermost ? (options.immediate === true ? 'BEGIN IMMEDIATE' : 'BEGIN') : `SAVEPOINT ${savepoint}`);
    this.#depth += 1;
    try {
      const result = fn();
      if (result instanceof Promise) throw new TypeError('transaction functions must be synchronous');
      this.#db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.#db.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // SQLite already rolled back (some errors end the transaction); the original error matters.
      }
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  close(): void {
    this.#db.close();
  }
}
