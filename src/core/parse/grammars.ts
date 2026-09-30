import { readFile } from 'node:fs/promises';
import { Language, Parser } from 'web-tree-sitter';
import type { TreeSitterLanguage } from './language.js';

/**
 * `grammars/` at the package root, filled by `scripts/copy-grammars.mjs`.
 * The relative path is the same from `src/core/parse/` and `dist/core/parse/` (ADR-013).
 */
const grammarsDir = new URL('../../../grammars/', import.meta.url);

const wasmFile: Readonly<Record<TreeSitterLanguage, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
};

let runtime: Promise<void> | undefined;
const parsers = new Map<TreeSitterLanguage, Promise<Parser>>();

async function createParser(language: TreeSitterLanguage): Promise<Parser> {
  runtime ??= Parser.init().catch((error: unknown) => {
    runtime = undefined;
    throw error;
  });
  await runtime;
  const wasm = await readFile(new URL(wasmFile[language], grammarsDir));
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  return parser;
}

/**
 * The parser for a language. The tree-sitter runtime and each grammar are
 * loaded once per thread and the parser is reused on every call.
 */
export function parserFor(language: TreeSitterLanguage): Promise<Parser> {
  let parser = parsers.get(language);
  if (parser === undefined) {
    parser = createParser(language);
    parsers.set(language, parser);
    // A failed load is not cached, so a later call can retry.
    parser.catch(() => {
      parsers.delete(language);
    });
  }
  return parser;
}
