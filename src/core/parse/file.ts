import type { ImportRef } from './imports.js';
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
  /** The file's imports (ADR-031); present only when asked for. */
  imports?: ImportRef[];
}

/** Parses a file in any supported language (ADR-013); `imports` also extracts its imports, from the same tree. */
export async function parseFile(source: string, language: SourceLanguage, options: { imports?: boolean } = {}): Promise<ParsedFile> {
  if (language === 'sql') return { symbols: extractSqlSymbols(source), normalized: normalizeSql(source), ...(options.imports === true ? { imports: [] } : {}) };
  return parseSource(source, language, options);
}
