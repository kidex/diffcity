import type { SourceLanguage } from './language.js';
import { extractSqlSymbols, normalizeSql } from './sql.js';
import type { ParsedSymbol } from './types.js';
import { parseSource } from './typescript.js';

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
