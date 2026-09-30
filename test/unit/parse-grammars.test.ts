import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parserFor } from '../../src/core/parse/grammars.js';
import type { TreeSitterLanguage } from '../../src/core/parse/language.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/parse/grammars-load/${name}`, import.meta.url), 'utf8');

describe('grammars-load', () => {
  const cases: [TreeSitterLanguage, string, string][] = [
    ['typescript', 'sample.ts', 'function_declaration'],
    ['tsx', 'sample.tsx', 'lexical_declaration'],
    ['javascript', 'sample.js', 'function_declaration'],
  ];

  it.each(cases)('loads the %s grammar and parses %s without errors', async (language, file, firstType) => {
    const parser = await parserFor(language);
    const tree = parser.parse(fixture(file));
    expect(tree).not.toBeNull();
    try {
      const root = tree?.rootNode;
      expect(root?.type).toBe('program');
      expect(root?.hasError).toBe(false);
      expect(root?.namedChildren[0]?.namedChildren[0]?.type).toBe(firstType);
    } finally {
      tree?.delete();
    }
  });

  it('initialises once and reuses the same parser', async () => {
    const [a, b] = await Promise.all([parserFor('typescript'), parserFor('typescript')]);
    expect(a).toBe(b);
    expect(await parserFor('tsx')).not.toBe(a);
  });
});
