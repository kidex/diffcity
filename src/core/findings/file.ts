// Reading a findings file for `diffcity import` (ADR-036): the format is
// detected from the JSON, then parseOwn or parseSarif runs. Pure: the CLI reads
// the bytes (at most MAX_FINDINGS_FILE_BYTES) and passes the text. No parser,
// no Report code: the CLI loads this module.

import { parseOwn, parseSarif } from './parse.js';
import type { ParseResult } from './types.js';

/** The largest findings file `diffcity import` reads (ADR-036). */
export const MAX_FINDINGS_FILE_BYTES = 8 * 1024 * 1024;

export type FindingsFormat = 'own' | 'sarif';

export type FindingsFileResult = (Extract<ParseResult, { ok: true }> & { format: FindingsFormat }) | Extract<ParseResult, { ok: false }>;

/**
 * SARIF when the JSON is an object with a `$schema`, or with both `version`
 * and `runs`; the own format otherwise (parseOwn then says what is wrong).
 */
export function detectFindingsFormat(json: unknown): FindingsFormat {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'own';
  const fields = json as Record<string, unknown>;
  if (fields['$schema'] !== undefined) return 'sarif';
  return fields['version'] !== undefined && fields['runs'] !== undefined ? 'sarif' : 'own';
}

/** Parses the text of a findings file; `repoRoot` is the working tree root, for absolute paths. */
export function parseFindingsText(text: string, repoRoot: string): FindingsFileResult {
  let json: unknown;
  try {
    // A leading byte order mark is not JSON, but editors write one.
    json = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch (error) {
    return { ok: false, errors: [`the file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const format = detectFindingsFormat(json);
  const result = format === 'sarif' ? parseSarif(json, repoRoot) : parseOwn(json, repoRoot);
  return result.ok ? { ...result, format } : result;
}
