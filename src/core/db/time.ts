// Time and JSON columns (ADR-018): times are ISO 8601 UTC text, normalized to
// the Date#toISOString form so that text comparison in SQL orders them
// correctly; JSON columns are text written by the stores themselves.

/** Archived changes and `collect` events are kept this many days (ADR-018, ADR-019). */
export const RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

/** A timestamp with a date, a time and an explicit zone (`Z` or an offset). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The stored form of a time: `YYYY-MM-DDTHH:mm:ss.sssZ`. Rejects values without
 * a zone, which Date would read as local time, and anything that does not parse.
 */
export function isoTime(value: string, field: string): string {
  const ms = ISO_WITH_ZONE.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`${field} must be an ISO 8601 time with a zone, got ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

/** The stored form of `now` minus RETENTION_DAYS: rows strictly older than it are deleted. */
export function retentionCutoff(now: string): string {
  return new Date(Date.parse(isoTime(now, 'now')) - RETENTION_DAYS * DAY_MS).toISOString();
}

/** JSON text for a column, or null for a null value. */
export function jsonOrNull(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

/** Parses a JSON column written by a store; null stays null. */
export function parseJsonOrNull(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}
