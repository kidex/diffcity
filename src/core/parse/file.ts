import type { SourceLanguage } from './language.js';
import { extractSqlSymbols, normalizeSql } from './sql.js';
import type { ParsedSymbol } from './types.js';
import { parseSource } from './typescript.js';

/**
 * A file above this many bytes, on either side, is neither read whole nor
 * parsed: it is hashed from a stream and its status comes from git, as for a
 * non-code file (ADR-008). Same figure as the diff view's side limit (ADR-027).
 */
export const MAX_PARSE_BYTES = 2 * 1024 * 1024;

/** One version of a source file: its top-level symbols and its whole-file normal form. */
export interface ParsedFile {
  symbols: ParsedSymbol[];
  /**
   * ADR-005 normal form of the whole file. Equal between two versions exactly
   * when they differ only in whitespace and non-directive comments.
   */
  normalized: string;
}

/** Parses a file in any supported language (ADR-013). */
export async function parseFile(source: string, language: SourceLanguage): Promise<ParsedFile> {
  if (language === 'sql') return { symbols: extractSqlSymbols(source), normalized: normalizeSql(source) };
  return parseSource(source, language);
}
