// node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature..."
// once per process on Node 22 (ADR-025). The warning is emitted synchronously
// when node:sqlite is first loaded, so this module must not import it, and the
// daemon must call the function before it first imports src/core/db (with a
// dynamic import() after the call, since static imports are evaluated first):
//
//   import { suppressSqliteExperimentalWarning } from '../core/db/warning.js';
//   suppressSqliteExperimentalWarning();
//   const { openDb } = await import('../core/db/index.js');
//
// Only that warning is dropped; every other warning goes through unchanged.
// Tests do not call it.

let installed = false;

function isSqliteExperimental(warning: string | Error, typeOrOptions: unknown): boolean {
  const message = typeof warning === 'string' ? warning : warning.message;
  const type =
    typeof warning !== 'string'
      ? warning.name
      : typeof typeOrOptions === 'string'
        ? typeOrOptions
        : typeof typeOrOptions === 'object' && typeOrOptions !== null && 'type' in typeOrOptions
          ? String(typeOrOptions.type)
          : 'Warning';
  return type === 'ExperimentalWarning' && message.includes('SQLite');
}

/** Wraps process.emitWarning to drop the SQLite ExperimentalWarning. Idempotent. */
export function suppressSqliteExperimentalWarning(): void {
  if (installed) return;
  installed = true;
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (isSqliteExperimental(warning, rest[0])) return;
    // The overloads of emitWarning cannot be forwarded generically; the arguments are passed through untouched.
    (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
  });
}
