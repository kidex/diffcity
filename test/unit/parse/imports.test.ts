// Import extraction (ADR-031): the import statements of one version, taken
// from the tree the parser already builds for the file's symbols.

import { describe, expect, it } from 'vitest';
import { parseFile } from '../../../src/core/parse/file.js';
import type { ImportRef } from '../../../src/core/parse/imports.js';
import type { SourceLanguage } from '../../../src/core/parse/language.js';

async function importsOf(source: string, language: SourceLanguage = 'typescript'): Promise<ImportRef[]> {
  const parsed = await parseFile(source, language, { imports: true });
  if (parsed.imports === undefined) throw new Error('no imports extracted');
  return parsed.imports;
}

describe('import extraction', () => {
  it('finds every statement kind with its line and specifier', async () => {
    const source = [
      "import { postEntry } from './ledger/post.js';",
      "import './ledger/setup.js';",
      "export { balance } from './ledger/balance.js';",
      "export * from './ledger/all.js';",
      "import fs = require('./ledger/legacy');",
      "const cfg = require('./ledger/config.cjs');",
      'export function load() {',
      "  return import('./ledger/lazy.js');",
      '}',
      '',
    ].join('\n');
    expect(await importsOf(source)).toEqual([
      { specifier: './ledger/post.js', line: 1, typeOnly: false },
      { specifier: './ledger/setup.js', line: 2, typeOnly: false },
      { specifier: './ledger/balance.js', line: 3, typeOnly: false },
      { specifier: './ledger/all.js', line: 4, typeOnly: false },
      { specifier: './ledger/legacy', line: 5, typeOnly: false },
      { specifier: './ledger/config.cjs', line: 6, typeOnly: false },
      { specifier: './ledger/lazy.js', line: 8, typeOnly: false },
    ]);
  });

  it('flags type-only imports: import type, export type, and named imports that are all types', async () => {
    const source = [
      "import type { Entry } from './a.js';",
      "export type { Account } from './b.js';",
      "import { type Ledger, type Journal } from './c.js';",
      "import { type Ledger2, post } from './d.js';",
      "import Book, { type Page } from './e.js';",
      "import type Legacy = require('./f');",
      '',
    ].join('\n');
    expect((await importsOf(source)).map((ref) => [ref.specifier, ref.typeOnly])).toEqual([
      ['./a.js', true],
      ['./b.js', true],
      ['./c.js', true],
      ['./d.js', false],
      ['./e.js', false],
      ['./f', true],
    ]);
  });

  it('a template or computed specifier is kept with a null specifier', async () => {
    const source = ["const name = 'post';", 'const a = require(`./ledger/${name}`);', 'const b = import(name);', "const c = require('./ledger/fixed');", ''].join('\n');
    expect(await importsOf(source, 'javascript')).toEqual([
      { specifier: null, line: 2, typeOnly: false },
      { specifier: null, line: 3, typeOnly: false },
      { specifier: './ledger/fixed', line: 4, typeOnly: false },
    ]);
  });

  it('works in TSX and JavaScript; SQL has none; without the option nothing is extracted', async () => {
    expect(await importsOf("import { Card } from './card';\nexport const View = () => <Card />;\n", 'tsx')).toEqual([
      { specifier: './card', line: 1, typeOnly: false },
    ]);
    expect(await importsOf("import x from './x.mjs';\nexport * from './y.js';\n", 'javascript')).toHaveLength(2);
    expect(await importsOf('SELECT 1;\n', 'sql')).toEqual([]);
    expect((await parseFile("import x from './x';\n", 'typescript')).imports).toBeUndefined();
  });

  it('imports/dynamic-import-in-function-anchors-floor: a dynamic import keeps the line inside its function', async () => {
    const source = ['export async function openDrawer() {', '  const view = 1;', "  const mod = await import('../ui/drawer.js');", '  return mod;', '}', ''].join('\n');
    const parsed = await parseFile(source, 'typescript', { imports: true });
    expect(parsed.imports).toEqual([{ specifier: '../ui/drawer.js', line: 3, typeOnly: false }]);
    const fn = parsed.symbols.find((symbol) => symbol.name === 'openDrawer');
    expect(fn?.range).toEqual({ start: 1, end: 5 });
  });
});
