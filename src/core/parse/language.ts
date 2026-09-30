import { extname } from 'node:path';

/** Languages diffcity extracts symbols from (ADR-013). */
export type SourceLanguage = 'typescript' | 'tsx' | 'javascript' | 'sql';

/** Languages parsed with a tree-sitter grammar; SQL has its own tokenizer. */
export type TreeSitterLanguage = Exclude<SourceLanguage, 'sql'>;

const byExtension: Readonly<Record<string, SourceLanguage>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.sql': 'sql',
};

/** Maps a file path to its language by extension (case-insensitive), or `null` when unsupported. */
export function languageForPath(path: string): SourceLanguage | null {
  return byExtension[extname(path).toLowerCase()] ?? null;
}
