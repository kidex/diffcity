// Syntax highlighting for the file view (ADR-027): the highlights.scm queries
// shipped by tree-sitter-typescript and tree-sitter-javascript, run on the
// grammars the parser already loads, with the captures mapped to the ten
// classes of the UI. Only TypeScript, TSX and JavaScript are highlighted.

import { readFile } from 'node:fs/promises';
import { Query, type Language } from 'web-tree-sitter';
import type { HighlightClass } from '../model/types.js';
import { parserFor } from '../parse/grammars.js';
import type { TreeSitterLanguage } from '../parse/language.js';

/** The highlights of one line: `[start, end, class]` in UTF-16 units of the line. */
export type LineSpans = [start: number, end: number, cls: HighlightClass][];

const grammarsDir = new URL('../../../grammars/', import.meta.url);

/**
 * Query files per language, in order: later patterns win over earlier ones on
 * the same node. The TypeScript query only adds to the JavaScript one.
 */
const queryFiles: Readonly<Record<TreeSitterLanguage, readonly string[]>> = {
  javascript: ['tree-sitter-javascript.highlights.scm', 'tree-sitter-javascript.highlights-jsx.scm'],
  typescript: ['tree-sitter-javascript.highlights.scm', 'tree-sitter-typescript.highlights.scm'],
  tsx: ['tree-sitter-javascript.highlights.scm', 'tree-sitter-javascript.highlights-jsx.scm', 'tree-sitter-typescript.highlights.scm'],
};

/** Capture name (or its prefix before the first dot) to class; names not listed paint nothing. */
const classOfCapture = new Map<string, HighlightClass>([
  ['keyword', 'kw'],
  ['constant.builtin', 'kw'],
  ['string', 'str'],
  ['number', 'num'],
  ['comment', 'com'],
  ['type', 'type'],
  ['constructor', 'type'],
  ['function', 'fn'],
  ['property', 'prop'],
  ['attribute', 'prop'],
  ['operator', 'op'],
  ['punctuation', 'punc'],
  ['variable', 'var'],
  ['constant', 'var'],
  ['tag', 'type'],
]);

const CLASSES: readonly HighlightClass[] = ['kw', 'str', 'num', 'com', 'type', 'fn', 'prop', 'op', 'punc', 'var'];

function classOf(capture: string): HighlightClass | undefined {
  return classOfCapture.get(capture) ?? classOfCapture.get(capture.split('.')[0] ?? '');
}

/** The languages the file view highlights (File.language values). */
export function highlightLanguage(language: string): TreeSitterLanguage | null {
  return language === 'typescript' || language === 'tsx' || language === 'javascript' ? language : null;
}

const queries = new Map<TreeSitterLanguage, Promise<Query | null>>();

async function loadQuery(language: TreeSitterLanguage): Promise<Query | null> {
  const grammar: Language | null = (await parserFor(language)).language;
  if (grammar === null) return null;
  let source = '';
  try {
    for (const name of queryFiles[language]) source += `${await readFile(new URL(name, grammarsDir), 'utf8')}\n`;
  } catch {
    // The query files are missing (an install without them): no highlighting.
    return null;
  }
  try {
    return new Query(grammar, source);
  } catch {
    return null;
  }
}

function queryFor(language: TreeSitterLanguage): Promise<Query | null> {
  let query = queries.get(language);
  if (query === undefined) {
    query = loadQuery(language);
    queries.set(language, query);
    // A failed load is not cached, so a later call can retry.
    query.catch(() => {
      queries.delete(language);
    });
  }
  return query;
}

/**
 * The highlights of `text` per line (split on `\n`, the line index is the
 * array index), or null when the language has no query or the text cannot be
 * parsed. Narrower nodes win over wider ones, and a later pattern over an
 * earlier one on the same node.
 */
export async function highlightLines(language: string, text: string): Promise<LineSpans[] | null> {
  const name = highlightLanguage(language);
  if (name === null) return null;
  const query = await queryFor(name);
  if (query === null) return null;
  const parser = await parserFor(name);
  const tree = parser.parse(text);
  if (tree === null) return null;
  try {
    const captures = query
      .captures(tree.rootNode)
      .flatMap((capture) => {
        const cls = classOf(capture.name);
        return cls === undefined
          ? []
          : [{ start: capture.node.startIndex, end: capture.node.endIndex, pattern: capture.patternIndex, cls: CLASSES.indexOf(cls) + 1 }];
      })
      .sort((a, b) => b.end - b.start - (a.end - a.start) || a.pattern - b.pattern);
    // One class per UTF-16 unit; painting wide-to-narrow lets the narrow one stay.
    const paint = new Uint8Array(text.length);
    for (const capture of captures) paint.fill(capture.cls, capture.start, Math.min(capture.end, text.length));

    const lines: LineSpans[] = [];
    let lineStart = 0;
    while (lineStart <= text.length) {
      const newline = text.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? text.length : newline;
      const spans: LineSpans = [];
      let runStart = -1;
      let runClass = 0;
      for (let i = lineStart; i <= lineEnd; i++) {
        const cls = i < lineEnd ? (paint[i] ?? 0) : 0;
        if (cls !== runClass) {
          if (runClass !== 0) spans.push([runStart - lineStart, i - lineStart, CLASSES[runClass - 1] as HighlightClass]);
          runStart = i;
          runClass = cls;
        }
      }
      lines.push(spans);
      if (newline === -1) break;
      lineStart = newline + 1;
    }
    return lines;
  } finally {
    tree.delete();
  }
}
