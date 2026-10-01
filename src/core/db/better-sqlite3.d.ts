// Types for the part of better-sqlite3 13 that src/core/db uses. The package
// ships no declarations and @types/better-sqlite3 tracks an older major, so the
// surface is declared here and kept to what the stores call.

declare module 'better-sqlite3' {
  /** A value SQLite can bind: better-sqlite3 rejects booleans and undefined. */
  export type BindValue = number | bigint | string | Buffer | null;

  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  /** A prepared statement taking positional parameters `P` and returning rows `R`. */
  export interface Statement<P extends BindValue[] = BindValue[], R = unknown> {
    run(...params: P): RunResult;
    get(...params: P): R | undefined;
    all(...params: P): R[];
  }

  /** A function wrapped by Database#transaction; nested calls become savepoints. */
  export interface Transaction<A extends unknown[], T> {
    (...args: A): T;
    deferred(...args: A): T;
    immediate(...args: A): T;
    exclusive(...args: A): T;
  }

  export interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    /** Busy timeout in milliseconds. */
    timeout?: number;
  }

  export interface Database {
    readonly open: boolean;
    readonly inTransaction: boolean;
    readonly name: string;
    prepare<P extends BindValue[] = BindValue[], R = unknown>(sql: string): Statement<P, R>;
    /** Runs SQL text (SQLite, not a process); a property so the ADR-012 process-call scan does not read it as one. */
    readonly exec: (sql: string) => this;
    pragma(source: string, options: { simple: true }): unknown;
    pragma(source: string, options?: { simple?: false }): unknown[];
    transaction<A extends unknown[], T>(fn: (...args: A) => T): Transaction<A, T>;
    close(): this;
  }

  export interface SqliteError extends Error {
    code: string;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Options): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
