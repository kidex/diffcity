import { describe, expect, it } from 'vitest';
import { withDuplicateSuffixes } from '../../src/core/parse/dedupe.js';
import type { TreeSitterLanguage } from '../../src/core/parse/language.js';
import { extractSymbols } from '../../src/core/parse/typescript.js';
import type { ParsedSymbol } from '../../src/core/parse/types.js';

async function symbol(source: string, qualifiedName: string, language: TreeSitterLanguage = 'typescript'): Promise<ParsedSymbol> {
  const found = (await extractSymbols(source, language)).find((s) => s.qualifiedName === qualifiedName);
  if (found === undefined) throw new Error(`no symbol ${qualifiedName}`);
  return found;
}

const base = `export function applyDiscount(price: number, pct = 10) {
  const factor = 1 - pct / 100;
  return price * factor;
}
`;

describe('ADR-005 normalization', () => {
  it('whitespace-only reformat gives equal signature and body', async () => {
    const before = await symbol(base, 'applyDiscount');
    const after = await symbol(
      `export   function applyDiscount(
    price: number,
    pct = 10
) {
      const factor=1-pct/100;

  return price*factor;
}`,
      'applyDiscount',
    );
    expect(after.signature).toBe(before.signature);
    expect(after.body).toBe(before.body);
  });

  it('comment-only changes (line, block, JSDoc) give equal signature and body', async () => {
    const before = await symbol(base, 'applyDiscount');
    const after = await symbol(
      `/** Applies a percentage discount. */
export function applyDiscount(price: number /* gross */, pct = 10) {
  // keep two decimals later
  const factor = 1 - pct / 100; /* ratio */
  return price * factor;
}
`,
      'applyDiscount',
    );
    expect(after.signature).toBe(before.signature);
    expect(after.body).toBe(before.body);
  });

  it.each(['// @ts-ignore', '// @ts-expect-error', '// eslint-disable-next-line no-magic-numbers', '/* prettier-ignore */'])(
    'directive comment %s changes the body, not the signature',
    async (directive) => {
      const before = await symbol(base, 'applyDiscount');
      const after = await symbol(base.replace('  return', `  ${directive}\n  return`), 'applyDiscount');
      expect(after.signature).toBe(before.signature);
      expect(after.body).not.toBe(before.body);
    },
  );

  it('a directive comment right above a declaration belongs to its body', async () => {
    const before = await symbol(base, 'applyDiscount');
    const after = await symbol(`// @ts-nocheck\n${base}`, 'applyDiscount');
    expect(after.body).not.toBe(before.body);
  });

  it('spaces inside string and template literals count', async () => {
    const plain = await symbol("export const greet = () => 'hello world';", 'greet');
    const spaced = await symbol("export const greet = () => 'hello  world';", 'greet');
    expect(spaced.body).not.toBe(plain.body);
    const template = await symbol('export const greet = (n: string) => `hi ${n}`;', 'greet');
    const templateSpaced = await symbol('export const greet = (n: string) => `hi  ${n}`;', 'greet');
    expect(templateSpaced.body).not.toBe(template.body);
    const substitutionSpaced = await symbol('export const greet = (n: string) => `hi ${ n }`;', 'greet');
    expect(substitutionSpaced.body).not.toBe(template.body);
  });

  it('semicolons and trailing commas are tokens', async () => {
    const before = await symbol(base, 'applyDiscount');
    const noSemicolon = await symbol(base.replace('price * factor;', 'price * factor'), 'applyDiscount');
    expect(noSemicolon.body).not.toBe(before.body);
    const trailingComma = await symbol(base.replace('pct = 10)', 'pct = 10,)'), 'applyDiscount');
    expect(trailingComma.signature).not.toBe(before.signature);
  });

  it('JSX text is compared the way JSX renders it', async () => {
    const before = await symbol('export const Tag = () => <b>on sale</b>;', 'Tag', 'tsx');
    const reflowed = await symbol('export const Tag = () => <b>\n    on sale\n  </b>;', 'Tag', 'tsx');
    const edited = await symbol('export const Tag = () => <b>on  sale</b>;', 'Tag', 'tsx');
    expect(reflowed.body).toBe(before.body);
    expect(edited.body).not.toBe(before.body);
  });
});

describe('ADR-006 signature', () => {
  it('renaming a parameter changes the signature', async () => {
    const before = await symbol(base, 'applyDiscount');
    const after = await symbol(base.replaceAll('pct', 'percent'), 'applyDiscount');
    expect(after.signature).not.toBe(before.signature);
  });

  it('changing a default value changes the signature', async () => {
    const before = await symbol(base, 'applyDiscount');
    const after = await symbol(base.replace('pct = 10', 'pct = 15'), 'applyDiscount');
    expect(after.signature).not.toBe(before.signature);
  });

  it('adding async changes the signature', async () => {
    const before = await symbol(base, 'applyDiscount');
    const after = await symbol(base.replace('export function', 'export async function'), 'applyDiscount');
    expect(after.signature).not.toBe(before.signature);
  });

  it('adding an explicit return type changes the signature', async () => {
    const before = await symbol(base, 'applyDiscount');
    const after = await symbol(base.replace('pct = 10)', 'pct = 10): number'), 'applyDiscount');
    expect(after.signature).not.toBe(before.signature);
  });

  it('a change of the inferred return type only changes the body', async () => {
    const before = await symbol(base, 'applyDiscount');
    const after = await symbol(base.replace('return price * factor;', 'return String(price * factor);'), 'applyDiscount');
    expect(after.signature).toBe(before.signature);
    expect(after.body).not.toBe(before.body);
  });

  it('arrow functions: parentheses around a single parameter are not a signature change', async () => {
    const bare = await symbol('const double = n => n * 2;', 'double', 'javascript');
    const wrapped = await symbol('const double = (n) => n * 2;', 'double', 'javascript');
    expect(wrapped.signature).toBe(bare.signature);
  });

  it('a changed method does not change the class signature or body', async () => {
    const source = 'export class Till {\n  total = 0;\n  add(n: number) {\n    this.total += n;\n  }\n}\n';
    const beforeClass = await symbol(source, 'Till');
    const afterClass = await symbol(source.replace('this.total += n', 'this.total -= n'), 'Till');
    expect(afterClass.signature).toBe(beforeClass.signature);
    expect(afterClass.body).toBe(beforeClass.body);
    const beforeMethod = await symbol(source, 'Till.add');
    const afterMethod = await symbol(source.replace('this.total += n', 'this.total -= n'), 'Till.add');
    expect(afterMethod.body).not.toBe(beforeMethod.body);
  });

  it('a changed class field changes the class body', async () => {
    const source = 'export class Till {\n  total = 0;\n}\n';
    const before = await symbol(source, 'Till');
    const after = await symbol(source.replace('total = 0', 'total = 1'), 'Till');
    expect(after.signature).toBe(before.signature);
    expect(after.body).not.toBe(before.body);
  });

  it('class signature follows extends, implements, abstract and decorators', async () => {
    const source = 'export class Till extends Drawer {}\n';
    const before = await symbol(source, 'Till');
    for (const changed of [
      'export class Till extends Box {}\n',
      'export class Till extends Drawer implements Countable {}\n',
      'export abstract class Till extends Drawer {}\n',
      '@tracked\nexport class Till extends Drawer {}\n',
      'export class Till<T> extends Drawer {}\n',
    ]) {
      expect((await symbol(changed, 'Till')).signature).not.toBe(before.signature);
    }
  });

  it('value export: the type annotation is the signature, the initializer is the body', async () => {
    const before = await symbol('export const LIMIT: number = 5;', 'LIMIT');
    const retyped = await symbol('export const LIMIT: 5 = 5;', 'LIMIT');
    const revalued = await symbol('export const LIMIT: number = 6;', 'LIMIT');
    expect(retyped.signature).not.toBe(before.signature);
    expect(revalued.signature).toBe(before.signature);
    expect(revalued.body).not.toBe(before.body);
  });

  it('exported interface: type parameters are the signature, a new property changes only the body', async () => {
    const before = await symbol('export interface Row<T> {\n  id: T;\n}\n', 'Row');
    const added = await symbol('export interface Row<T> {\n  id: T;\n  label: string;\n}\n', 'Row');
    const generic = await symbol('export interface Row<T, K> {\n  id: T;\n}\n', 'Row');
    expect(added.signature).toBe(before.signature);
    expect(added.body).not.toBe(before.body);
    expect(generic.signature).not.toBe(before.signature);
  });

  it('overloads: changing one overload signature changes the signature', async () => {
    const source = 'function pick(a: string): string;\nfunction pick(a: number): number;\nfunction pick(a: unknown) {\n  return a;\n}\n';
    const before = await symbol(source, 'pick');
    const after = await symbol(source.replace('pick(a: number): number', 'pick(a: bigint): bigint'), 'pick');
    expect(after.signature).not.toBe(before.signature);
  });
});

describe('withDuplicateSuffixes', () => {
  it('suffixes repeated names with ~2, ~3 in order', () => {
    expect(withDuplicateSuffixes(['a', 'b', 'a', 'a', 'b', 'c'])).toEqual(['a', 'b', 'a~2', 'a~3', 'b~2', 'c']);
  });

  it('returns an empty list for no names', () => {
    expect(withDuplicateSuffixes([])).toEqual([]);
  });
});
