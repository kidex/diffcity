import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../../src/core/parse/typescript.js';
import type { TreeSitterLanguage } from '../../src/core/parse/language.js';
import type { ParsedSymbol } from '../../src/core/parse/types.js';

async function parseFixture(path: string, language: TreeSitterLanguage): Promise<ParsedSymbol[]> {
  const source = readFileSync(new URL(`../fixtures/parse/${path}`, import.meta.url), 'utf8');
  return extractSymbols(source, language);
}

/** Compact view: qualified name, kind and 1-based inclusive line range. */
function outline(symbols: ParsedSymbol[]): [string, ParsedSymbol['kind'], number, number][] {
  return symbols.map((s) => [s.qualifiedName, s.kind, s.range.start, s.range.end]);
}

function find(symbols: ParsedSymbol[], qualifiedName: string): ParsedSymbol {
  const symbol = symbols.find((s) => s.qualifiedName === qualifiedName);
  if (symbol === undefined) throw new Error(`no symbol ${qualifiedName}`);
  return symbol;
}

describe('extractSymbols', () => {
  it('kind-function: declarations, generators, overloads and anonymous default export', async () => {
    const symbols = await parseFixture('kind-function/input.ts', 'typescript');
    expect(outline(symbols)).toEqual([
      ['priceWithTax', 'function', 1, 3],
      ['streamInvoices', 'function', 5, 7],
      ['roundCents', 'function', 9, 13],
      ['default', 'function', 15, 17],
    ]);
    expect(find(symbols, 'priceWithTax').signatureText).toBe(
      'export function priceWithTax(amount: number, rate = 0.2): number',
    );
    expect(find(symbols, 'priceWithTax').signature).toBe('( amount : number , rate = 0.2 ) : number');
    expect(find(symbols, 'streamInvoices').signature).toBe('async * ( ids : string [ ] )');
    const overloaded = find(symbols, 'roundCents');
    expect(overloaded.signature.split('\n')).toEqual([
      '( value : string ) : number',
      '( value : number ) : number',
      '( value : string | number ) : number',
    ]);
    expect(overloaded.signatureText.split('\n')).toEqual([
      'export function roundCents(value: string): number',
      'export function roundCents(value: number): number',
      'export function roundCents(value: string | number): number',
    ]);
  });

  it('kind-arrow-const: const/let/var bound to arrow functions or function expressions', async () => {
    const symbols = await parseFixture('kind-arrow-const/input.ts', 'typescript');
    expect(outline(symbols)).toEqual([
      ['addFee', 'function', 1, 1],
      ['describeOrder', 'function', 3, 5],
      ['legacyFormat', 'function', 7, 9],
      ['identity', 'function', 11, 11],
      ['trimLabel', 'function', 15, 15],
      ['shout', 'function', 17, 17],
      ['whisper', 'function', 17, 17],
    ]);
    expect(find(symbols, 'describeOrder').signature).toBe('async < T , > ( order : T )');
    expect(find(symbols, 'describeOrder').signatureText).toBe('export const describeOrder = async <T,>(order: T) =>');
    expect(find(symbols, 'trimLabel').signature).toBe(': Formatter ( text )');
    expect(find(symbols, 'whisper').signatureText).toBe('whisper = (text: string) =>');
  });

  it('kind-class: decorators, heritage, default class and non-exported classes', async () => {
    const symbols = await parseFixture('kind-class/input.ts', 'typescript');
    expect(outline(symbols)).toEqual([
      ['InvoiceBook', 'class', 1, 8],
      ['InvoiceBook.count', 'method', 5, 7],
      ['default', 'class', 10, 12],
      ['Unexported', 'class', 14, 14],
    ]);
    const book = find(symbols, 'InvoiceBook');
    expect(book.signature).toBe('@ sealed abstract < T > extends LedgerBase implements Printable');
    expect(book.signatureText).toBe(
      '@sealed\nexport abstract class InvoiceBook<T> extends LedgerBase implements Printable',
    );
    expect(book.body).toContain('private readonly entries');
    expect(book.body).not.toContain('count');
  });

  it('kind-method: constructor, accessors, modifiers, private names, arrow fields, overloads, abstract', async () => {
    const symbols = await parseFixture('kind-method/input.ts', 'typescript');
    expect(outline(symbols)).toEqual([
      ['Cashier', 'class', 1, 34],
      ['Cashier.constructor', 'method', 4, 4],
      ['Cashier.get balance', 'method', 6, 8],
      ['Cashier.set balance', 'method', 10, 12],
      ['Cashier.drain', 'method', 14, 16],
      ['Cashier.#audit', 'method', 18, 20],
      ['Cashier.onClose', 'method', 22, 25],
      ['Cashier.refund', 'method', 27, 31],
      ['Drawer', 'class', 36, 38],
      ['Drawer.open', 'method', 37, 37],
    ]);
    expect(find(symbols, 'Cashier.get balance').name).toBe('get balance');
    expect(find(symbols, 'Cashier.get balance').signature).toBe('( ) : number');
    expect(find(symbols, 'Cashier.set balance').signature).toBe('( value : number )');
    expect(find(symbols, 'Cashier.drain').signature).toBe(
      'protected static async * ( limit = 10 ) : AsyncGenerator < number >',
    );
    expect(find(symbols, 'Cashier.constructor').signature).toBe('( private readonly till : string )');
    expect(find(symbols, 'Cashier.onClose').signature).toBe('async ( reason : string )');
    expect(find(symbols, 'Cashier.onClose').body).toContain('@ logged');
    expect(find(symbols, 'Cashier.refund').signature.split('\n')).toHaveLength(3);
    expect(find(symbols, 'Drawer.open').signature).toBe('abstract ( ) : void');
    const cashier = find(symbols, 'Cashier');
    expect(cashier.body).toContain('static #instances = 0 ;');
    expect(cashier.body).toContain("label = 'till' ;");
    expect(cashier.body).not.toContain('logged');
    expect(cashier.body).not.toContain('refund');
    expect(cashier.body).toBe("class Cashier { static #instances = 0 ; label = 'till' ; }");
    expect(find(symbols, 'Cashier.onClose').body).toMatch(/} ;$/);
  });

  it('kind-export: values, types, specifiers, re-exports and default expressions', async () => {
    const symbols = await parseFixture('kind-export/input.ts', 'typescript');
    expect(outline(symbols)).toEqual([
      ['TAX_RATE', 'export', 1, 1],
      ['CURRENCY', 'export', 1, 1],
      ['counter', 'export', 2, 2],
      ['Receipt', 'export', 3, 5],
      ['ReceiptId', 'export', 6, 6],
      ['Channel', 'export', 7, 10],
      ['helper', 'export', 16, 16],
      ['assistant', 'export', 16, 16],
      ['formatReceipt', 'export', 17, 17],
      ["* from './totals'", 'export', 18, 18],
      ['taxes', 'export', 19, 19],
      ['default', 'export', 20, 20],
      ['createRegistry', 'function', 22, 24],
    ]);
    expect(find(symbols, 'TAX_RATE').signature).toBe(': number');
    expect(find(symbols, 'TAX_RATE').signatureText).toBe('TAX_RATE: number');
    expect(find(symbols, 'CURRENCY').signature).toBe('');
    expect(find(symbols, 'Receipt').signature).toBe('< T >');
    expect(find(symbols, 'Receipt').signatureText).toBe('export interface Receipt<T>');
    expect(find(symbols, 'Channel').signature).toBe('');
    expect(find(symbols, 'default').body).toBe('export default createRegistry ( ) ;');
  });

  it('kind-test-block: top-level describe/it/test with a literal title', async () => {
    const symbols = await parseFixture('kind-test-block/input.test.ts', 'typescript');
    expect(outline(symbols)).toEqual([
      ['invoice totals', 'function', 3, 7],
      ['rounds to cents', 'function', 9, 11],
      ['template title', 'function', 13, 13],
      ['skipped suite', 'function', 15, 15],
    ]);
    expect(find(symbols, 'invoice totals').signature).toBe('');
    expect(find(symbols, 'invoice totals').signatureText).toBe("describe('invoice totals')");
  });

  it('tsx-component: React components as functions, nested components ignored', async () => {
    const symbols = await parseFixture('tsx-component/input.tsx', 'tsx');
    expect(outline(symbols)).toEqual([
      ['Badge', 'function', 8, 13],
      ['Panel', 'function', 15, 22],
      ['default', 'export', 24, 24],
    ]);
  });

  it('js-esm: ES modules in plain JavaScript', async () => {
    const symbols = await parseFixture('js-esm/input.js', 'javascript');
    expect(outline(symbols)).toEqual([
      ['loadPebbles', 'function', 3, 5],
      ['PebbleJar', 'class', 7, 15],
      ['PebbleJar.add', 'method', 9, 11],
      ['PebbleJar.get size', 'method', 12, 14],
      ['JAR_LIMIT', 'export', 17, 17],
      ['shake', 'function', 18, 18],
      ['default', 'export', 19, 19],
    ]);
    expect(find(symbols, 'PebbleJar.add').signature).toBe('( n = 1 )');
  });

  it('commonjs-ignored: module.exports and exports.x are not symbols', async () => {
    const symbols = await parseFixture('commonjs-ignored/input.cjs', 'javascript');
    expect(outline(symbols)).toEqual([['joinParts', 'function', 3, 5]]);
  });

  it('duplicate-names: repeated names get ~2, ~3 in source order', async () => {
    const symbols = await parseFixture('duplicate-names/input.js', 'javascript');
    expect(outline(symbols)).toEqual([
      ['setup', 'function', 1, 3],
      ['setup~2', 'function', 4, 6],
      ['setup~3', 'function', 7, 9],
      ['Menu', 'class', 10, 13],
      ['Menu.render', 'method', 11, 11],
      ['Menu.render~2', 'method', 12, 12],
      ['Menu~2', 'class', 14, 16],
      ['Menu~2.render', 'method', 15, 15],
      ['menu', 'function', 17, 17],
      ['menu~2', 'function', 18, 18],
      ['Cart', 'class', 19, 21],
      ['Cart.total', 'method', 20, 20],
      ['Cart.total~2', 'function', 22, 22],
    ]);
    const ids = symbols.map((s) => s.qualifiedName);
    expect(new Set(ids).size).toBe(ids.length);
    expect(find(symbols, 'setup~2').name).toBe('setup');
    expect(symbols.map((s) => s.baseQualifiedName)).toEqual([
      'setup',
      'setup',
      'setup',
      'Menu',
      'Menu.render',
      'Menu.render',
      'Menu',
      'Menu.render',
      'menu',
      'menu',
      'Cart',
      'Cart.total',
      'Cart.total',
    ]);
  });

  it('nested-not-symbol: nested functions, local classes, object literal methods and blocks are ignored', async () => {
    const symbols = await parseFixture('nested-not-symbol/input.ts', 'typescript');
    expect(outline(symbols)).toEqual([
      ['outer', 'function', 1, 10],
      ['toolkit', 'export', 12, 17],
    ]);
  });

  it('syntax-error: does not throw and ignores symbols inside ERROR regions', async () => {
    const symbols = await parseFixture('syntax-error/input.ts', 'typescript');
    const names = symbols.map((s) => s.qualifiedName);
    expect(names).toContain('before');
    expect(names).not.toContain('broken');
    expect(names).not.toContain('lost');
    expect(find(symbols, 'before').range).toEqual({ start: 1, end: 3 });
  });

  it('syntax-error: garbage input yields no symbols and no exception', async () => {
    await expect(extractSymbols('}}} ((( class { =>', 'typescript')).resolves.toEqual([]);
    await expect(extractSymbols('', 'javascript')).resolves.toEqual([]);
  });

  it('keeps the signature text of non-ASCII sources intact', async () => {
    const [symbol] = await extractSymbols("export function grüße(név = 'ő'): string {\n  return név;\n}\n", 'typescript');
    expect(symbol?.signatureText).toBe("export function grüße(név = 'ő'): string");
  });
});
