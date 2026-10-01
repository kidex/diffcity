// Validation of route parameters and query strings for the JSON API. A bad
// value is a 400 with a JSON error (ADR-017), never a 500.

import { HttpError } from '../http/errors.js';

/** Default and maximum `limit` of GET /api/search. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

/** A query value as Fastify parses it: repeated keys become an array. */
type QueryValue = string | string[] | undefined;

export type Query = Record<string, QueryValue>;

function single(name: string, value: QueryValue): string | undefined {
  if (Array.isArray(value)) throw new HttpError(400, 'bad-request', `${name} must be given once`);
  return value;
}

/** A SQLite row id: a positive safe integer written in decimal without a sign or leading zeros. */
export function parseId(name: string, value: string | undefined): number {
  const id = value !== undefined && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id)) throw new HttpError(400, 'bad-request', `${name} must be a positive integer`);
  return id;
}

/** `archived=1` or `archived=true` lists archived changes; absent, `0` or `false` lists live ones. */
export function parseArchived(query: Query): boolean {
  const value = single('archived', query.archived);
  if (value === undefined || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new HttpError(400, 'bad-request', 'archived must be 1 or 0');
}

/** The raw search query; empty when absent. Cutting it to MAX_QUERY_LENGTH is done by core search. */
export function parseSearchQuery(query: Query): string {
  return single('q', query.q) ?? '';
}

/** `limit`: a positive integer, SEARCH_DEFAULT_LIMIT when absent, at most SEARCH_MAX_LIMIT. */
export function parseLimit(query: Query): number {
  const value = single('limit', query.limit);
  if (value === undefined) return SEARCH_DEFAULT_LIMIT;
  return Math.min(parseId('limit', value), SEARCH_MAX_LIMIT);
}
