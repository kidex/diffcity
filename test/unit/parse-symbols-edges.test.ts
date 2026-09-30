import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../../src/core/parse/typescript.js';
import type { ParsedSymbol } from '../../src/core/parse/types.js';

function outline(symbols: ParsedSymbol[]): [string, ParsedSymbol['kind'], number, number][] {
  return symbols.map((s) => [s.qualifiedName, s.kind, s.range.start, s.range.end]);
}

describe('extractSymbols edge cases', () => {
  it('range: CRLF line endings keep 1-based inclusive lines', async () => {
    const source = 'export function weigh(grams: number) {\r\n  return grams;\r\n}\r\nexport const SCALE = 1;';
    const symbols = await extractSymbols(source, 'typescript');
    expect(outline(symbols)).toEqual([
      ['weigh', 'function', 1, 3],
      ['SCALE', 'export', 4, 4],
    ]);
    expect(symbols[0]?.body).toBe('function weigh ( grams : number ) { return grams ; }');
  });

  it('range: a last symbol without a trailing newline ends on its closing line', async () => {
    const symbols = await extractSymbols('function sow() {}\nfunction reap() {\n}', 'typescript');
    expect(outline(symbols)).toEqual([
      ['sow', 'function', 1, 1],
      ['reap', 'function', 2, 3],
    ]);
  });

  it('kind-export: default arrow is a function named default, `x as default` is an export named default', async () => {
    expect(outline(await extractSymbols('export default () => 1;\n', 'typescript'))).toEqual([
      ['default', 'function', 1, 1],
    ]);
    expect(outline(await extractSymbols('const lantern = 1;\nexport { lantern as default };\n', 'typescript'))).toEqual([
      ['default', 'export', 2, 2],
    ]);
  });

  it('kind-method: getter and setter of one name are distinct; a static getter of the same name is a duplicate', async () => {
    const source = 'class Kettle {\n  get heat() { return 1; }\n  set heat(n) {}\n  static get heat() { return 2; }\n}\n';
    const symbols = await extractSymbols(source, 'typescript');
    expect(outline(symbols)).toEqual([
      ['Kettle', 'class', 1, 5],
      ['Kettle.get heat', 'method', 2, 2],
      ['Kettle.set heat', 'method', 3, 3],
      ['Kettle.get heat~2', 'method', 4, 4],
    ]);
    expect(symbols[3]?.signature).toBe('static ( )');
  });

  it('syntax-error: declarations after the ERROR region are still extracted', async () => {
    const source =
      'export function sprout(a: number): number {\n  return a;\n}\n\nfunction wilted( {\n  const petal = () => 1;\n\nexport function bloom(b: string) {\n  return b;\n}\n';
    const symbols = await extractSymbols(source, 'typescript');
    expect(outline(symbols)).toEqual([
      ['sprout', 'function', 1, 3],
      ['bloom', 'function', 8, 10],
    ]);
  });

  it('kind-test-block: test.only counts; nested it inside describe is not a symbol', async () => {
    const source = "test.only('solo tune', () => {});\ndescribe('choir', () => { it('inner verse', () => {}); });\n";
    expect(outline(await extractSymbols(source, 'typescript'))).toEqual([
      ['solo tune', 'function', 1, 1],
      ['choir', 'function', 2, 2],
    ]);
  });

  it('nested-not-symbol: methods of an exported object literal are not symbols', async () => {
    const symbols = await extractSymbols('export const pantry = { open() {}, shut: () => 1 };\n', 'javascript');
    expect(outline(symbols)).toEqual([['pantry', 'export', 1, 1]]);
  });

  it('js-esm: JSX in a .js file parses with the javascript grammar', async () => {
    const symbols = await extractSymbols('export const Knob = () => <button>turn</button>;\n', 'javascript');
    expect(outline(symbols)).toEqual([['Knob', 'function', 1, 1]]);
    expect(symbols[0]?.signature).toBe('( )');
  });

  it('kind-arrow-const: an exported named function expression is a function symbol', async () => {
    const symbols = await extractSymbols('export const stir = function whisk() {};\n', 'typescript');
    expect(outline(symbols)).toEqual([['stir', 'function', 1, 1]]);
  });
});
