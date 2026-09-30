import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareFile, heaviestStatus } from '../../src/core/diff/status.js';
import type { FileChange, GitChange } from '../../src/core/diff/status.js';
import type { Status, Symbol } from '../../src/core/report/types.js';

function readSide(fixture: string, side: 'before' | 'after', ext: string): string | null {
  const url = new URL(`../fixtures/status/${fixture}/${side}.${ext}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : null;
}

interface CaseInput {
  fixture: string;
  path: string;
  change: GitChange;
  oldPath?: string;
  binary?: boolean;
}

function fileChange({ fixture, path, change, oldPath, binary = false }: CaseInput): FileChange {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const before = binary ? null : readSide(fixture, 'before', ext);
  const after = binary ? null : readSide(fixture, 'after', ext);
  return oldPath === undefined
    ? { path, change, binary, before, after }
    : { path, oldPath, change, binary, before, after };
}

async function compare(input: CaseInput): Promise<{ status: Status; symbols: Symbol[] }> {
  return compareFile(fileChange(input));
}

/** Symbol id to status. */
function statuses(symbols: Symbol[]): Record<string, Status> {
  return Object.fromEntries(symbols.map((s) => [s.id, s.status]));
}

function byId(symbols: Symbol[], id: string): Symbol {
  const symbol = symbols.find((s) => s.id === id);
  if (symbol === undefined) throw new Error(`no symbol ${id}`);
  return symbol;
}

describe('5.1 symbol status', () => {
  it('S1 add: symbol only in after', async () => {
    const result = await compare({ fixture: 'add-function', path: 'src/flour.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/flour.ts#weighFlour': 'same', 'src/flour.ts#siftFlour': 'add' });
    expect(byId(result.symbols, 'src/flour.ts#siftFlour').range).toEqual({ start: 5, end: 7 });
    expect(result.status).toBe('add');
  });

  it('S2 del: symbol only in before, range from the before version', async () => {
    const result = await compare({ fixture: 'del-function', path: 'src/flour.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/flour.ts#weighFlour': 'same', 'src/flour.ts#siftFlour': 'del' });
    expect(byId(result.symbols, 'src/flour.ts#siftFlour').range).toEqual({ start: 5, end: 7 });
    expect(result.status).toBe('del');
  });

  it.each([
    ['sig-param-added', 'knead', 'export function knead(dough: string): string', 'export function knead(dough: string, minutes: number): string'],
    ['sig-param-removed', 'decant', 'export function decant(jar: string, spoon: number): string', 'export function decant(jar: string): string'],
    ['sig-param-retyped', 'proof', 'export function proof(minutes: number): boolean', 'export function proof(minutes: string): boolean'],
    ['sig-return-changed', 'ovenTemp', 'export function ovenTemp(level: number): number', 'export function ovenTemp(level: number): string'],
    ['sig-param-renamed', 'slice', 'export function slice(loaf: string): string[]', 'export function slice(bread: string): string[]'],
    ['sig-default-changed', 'glaze', 'export function glaze(layers = 1): number', 'export function glaze(layers = 2): number'],
    ['sig-async-added', 'coolDown', 'export function coolDown(minutes: number): number', 'export async function coolDown(minutes: number): number'],
  ])('S3 sig: %s', async (fixture, name, signatureBefore, signatureAfter) => {
    const result = await compare({ fixture, path: 'src/bakery.ts', change: 'mod' });
    expect(result.symbols).toEqual([
      {
        id: `src/bakery.ts#${name}`,
        name,
        kind: 'function',
        status: 'sig',
        range: { start: 1, end: 3 },
        signatureBefore,
        signatureAfter,
      },
    ]);
    expect(result.status).toBe('sig');
  });

  it('S4 mod: same signature, body changed', async () => {
    const result = await compare({ fixture: 'mod-body', path: 'src/frosting.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/frosting.ts#frost': 'mod' });
    expect(byId(result.symbols, 'src/frosting.ts#frost')).not.toHaveProperty('signatureBefore');
    expect(byId(result.symbols, 'src/frosting.ts#frost')).not.toHaveProperty('signatureAfter');
    expect(result.status).toBe('mod');
  });

  it('S4 mod: a change to the inferred return type alone is mod, not sig (ADR-006)', async () => {
    const result = await compare({ fixture: 'mod-inferred-return-only', path: 'src/crust.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/crust.ts#crustColor': 'mod' });
    expect(result.status).toBe('mod');
  });

  it('S5 same: identical versions', async () => {
    const result = await compare({ fixture: 'same', path: 'src/whisk.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/whisk.ts#whisk': 'same' });
    expect(result.status).toBe('same');
  });

  it.each([
    ['whitespace-only', 'fold'],
    ['comment-only', 'rest'],
    ['jsdoc-only', 'roll'],
  ])('S6 same: %s change (ADR-005)', async (fixture, name) => {
    const result = await compare({ fixture, path: 'src/pastry.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ [`src/pastry.ts#${name}`]: 'same' });
    expect(result.status).toBe('same');
  });

  it('S6 mod: an added directive comment counts as a body change (ADR-005)', async () => {
    const result = await compare({ fixture: 'directive-comment-added', path: 'src/score.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/score.ts#score': 'mod' });
    expect(result.status).toBe('mod');
  });

  it('S6 same: SQL whitespace and comments only', async () => {
    const before = readFileSync(new URL('../fixtures/sql/whitespace-comment-only/before.sql', import.meta.url), 'utf8');
    const after = readFileSync(new URL('../fixtures/sql/whitespace-comment-only/after.sql', import.meta.url), 'utf8');
    const result = await compareFile({ path: 'db/batches.sql', change: 'mod', binary: false, before, after });
    expect(result.symbols.map((s) => s.status)).toEqual(['same', 'same']);
    expect(result.status).toBe('same');
  });

  it('S7 file status is the heaviest symbol status: add + sig gives sig', async () => {
    const result = await compare({ fixture: 'file-mixed', path: 'src/brush.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/brush.ts#brush': 'sig', 'src/brush.ts#sprinkle': 'add' });
    expect(result.status).toBe('sig');
  });

  it('S7 add beats del and mod', async () => {
    const result = await compare({ fixture: 'file-add-beats-del', path: 'src/dust.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({
      'src/dust.ts#dust': 'mod',
      'src/dust.ts#oldGlaze': 'del',
      'src/dust.ts#newGlaze': 'add',
    });
    expect(result.status).toBe('add');
  });

  it('S7 order sig > add > del > mod > same', () => {
    expect(heaviestStatus([])).toBe('same');
    expect(heaviestStatus(['same', 'mod'])).toBe('mod');
    expect(heaviestStatus(['mod', 'del', 'same'])).toBe('del');
    expect(heaviestStatus(['del', 'add', 'mod'])).toBe('add');
    expect(heaviestStatus(['add', 'sig', 'del'])).toBe('sig');
  });

  it('S8 new file: every symbol add', async () => {
    const result = await compare({ fixture: 'new-file', path: 'src/pantry.ts', change: 'add' });
    expect(result.symbols.map((s) => [s.id, s.kind, s.status, s.range])).toEqual([
      ['src/pantry.ts#Pantry', 'class', 'add', { start: 1, end: 5 }],
      ['src/pantry.ts#Pantry.count', 'method', 'add', { start: 2, end: 4 }],
      ['src/pantry.ts#openPantry', 'function', 'add', { start: 7, end: 9 }],
    ]);
    expect(result.status).toBe('add');
  });

  it('S9 deleted file: every symbol del', async () => {
    const result = await compare({ fixture: 'deleted-file', path: 'src/pantry.ts', change: 'del' });
    expect(result.symbols.map((s) => [s.id, s.status, s.range])).toEqual([
      ['src/pantry.ts#Pantry', 'del', { start: 1, end: 5 }],
      ['src/pantry.ts#Pantry.count', 'del', { start: 2, end: 4 }],
      ['src/pantry.ts#openPantry', 'del', { start: 7, end: 9 }],
    ]);
    expect(result.status).toBe('del');
  });

  it('S10 kind function: declaration sig, arrow const mod', async () => {
    const result = await compare({ fixture: 'kind-function', path: 'src/whip.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/whip.ts#whip': 'sig', 'src/whip.ts#beat': 'mod' });
    expect(result.symbols.every((s) => s.kind === 'function')).toBe(true);
    expect(result.status).toBe('sig');
  });

  it('S10 kind class: type parameter added is sig, class only in before/after is del/add', async () => {
    const result = await compare({ fixture: 'kind-class', path: 'src/tools.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({
      'src/tools.ts#Mixer': 'sig',
      'src/tools.ts#Mixer.spin': 'same',
      'src/tools.ts#Whisk': 'del',
      'src/tools.ts#Spatula': 'add',
    });
    expect(byId(result.symbols, 'src/tools.ts#Mixer')).toMatchObject({
      kind: 'class',
      signatureBefore: 'export class Mixer',
      signatureAfter: 'export class Mixer<T>',
    });
    expect(result.status).toBe('sig');
  });

  it('S10 kind method: sig, mod on a getter, add and del', async () => {
    const result = await compare({ fixture: 'kind-method', path: 'src/timer.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({
      'src/timer.ts#Timer': 'same',
      'src/timer.ts#Timer.start': 'sig',
      'src/timer.ts#Timer.get remaining': 'mod',
      'src/timer.ts#Timer.stop': 'del',
      'src/timer.ts#Timer.pause': 'add',
    });
    expect(byId(result.symbols, 'src/timer.ts#Timer.get remaining')).toMatchObject({
      name: 'Timer.get remaining',
      kind: 'method',
    });
    expect(result.status).toBe('sig');
  });

  it('S10 kind export: initializer is the body, type annotation the signature', async () => {
    const result = await compare({ fixture: 'kind-export', path: 'src/trays.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({
      'src/trays.ts#MAX_TRAYS': 'mod',
      'src/trays.ts#shelfLabel': 'sig',
      'src/trays.ts#Tray': 'same',
      'src/trays.ts#trayLimit': 'del',
      'src/trays.ts#trayCap': 'add',
    });
    expect(byId(result.symbols, 'src/trays.ts#shelfLabel')).toMatchObject({
      kind: 'export',
      signatureBefore: 'shelfLabel: string',
      signatureAfter: "shelfLabel: 'top' | 'bottom'",
    });
    expect(result.status).toBe('sig');
  });

  it('S10 kind sql: statements are never sig', async () => {
    const result = await compare({ fixture: 'kind-sql', path: 'db/loaves.sql', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({
      'db/loaves.sql#CREATE TABLE loaves': 'mod',
      'db/loaves.sql#CREATE INDEX loaves_name_idx': 'same',
      'db/loaves.sql#DROP TABLE stale_loaves': 'del',
      'db/loaves.sql#ALTER TABLE loaves': 'add',
    });
    expect(result.symbols.every((s) => s.kind === 'sql')).toBe(true);
    expect(result.status).toBe('add');
  });
});

describe('5.1 classes, interfaces and overloads (ADR-006)', () => {
  it('a changed method is mod; its class stays same', async () => {
    const result = await compare({ fixture: 'class-member-change', path: 'src/oven.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({
      'src/oven.ts#Oven': 'same',
      'src/oven.ts#Oven.heat': 'mod',
      'src/oven.ts#Oven.cool': 'same',
    });
    expect(byId(result.symbols, 'src/oven.ts#Oven.heat').name).toBe('Oven.heat');
    expect(result.status).toBe('mod');
  });

  it('a changed extends clause is sig on the class', async () => {
    const result = await compare({ fixture: 'class-extends-changed', path: 'src/proofer.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({
      'src/proofer.ts#Appliance': 'same',
      'src/proofer.ts#HeatedAppliance': 'same',
      'src/proofer.ts#Proofer': 'sig',
      'src/proofer.ts#Proofer.start': 'same',
    });
    expect(byId(result.symbols, 'src/proofer.ts#Proofer')).toMatchObject({
      signatureBefore: 'export class Proofer extends Appliance',
      signatureAfter: 'export class Proofer extends HeatedAppliance',
    });
    expect(result.status).toBe('sig');
  });

  it('a new interface property is mod', async () => {
    const result = await compare({ fixture: 'interface-prop-added', path: 'src/recipe.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/recipe.ts#Recipe': 'mod' });
    expect(result.status).toBe('mod');
  });

  it('an added overload is sig on the single overloaded symbol', async () => {
    const result = await compare({ fixture: 'overloads', path: 'src/portion.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/portion.ts#portion': 'sig' });
    const portion = byId(result.symbols, 'src/portion.ts#portion');
    expect(portion.signatureBefore?.split('\n')).toHaveLength(3);
    expect(portion.signatureAfter?.split('\n')).toHaveLength(4);
    expect(portion.range).toEqual({ start: 1, end: 6 });
    expect(result.status).toBe('sig');
  });
});

describe('5.1 files without changed symbols (ADR-008)', () => {
  it('import-only change: symbols same, file takes git status mod', async () => {
    const result = await compare({ fixture: 'imports-only', path: 'src/bake.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/bake.ts#bake': 'same' });
    expect(result.status).toBe('mod');
  });

  it('top-level statement change: symbols same, file mod', async () => {
    const result = await compare({ fixture: 'top-level-statement-only', path: 'src/decorate.ts', change: 'mod' });
    expect(statuses(result.symbols)).toEqual({ 'src/decorate.ts#decorate': 'same' });
    expect(result.status).toBe('mod');
  });

  it.each<[string, GitChange, Status]>([
    ['non-code-file-added', 'add', 'add'],
    ['non-code-file-modified', 'mod', 'mod'],
    ['non-code-file-deleted', 'del', 'del'],
  ])('%s: git status, no symbols', async (fixture, change, status) => {
    const result = await compare({ fixture, path: 'docs/pantry.md', change });
    expect(result).toEqual({ status, symbols: [] });
  });

  it('non-code file renamed: mod, no symbols', async () => {
    const result = await compare({
      fixture: 'non-code-file-modified',
      path: 'docs/larder.md',
      oldPath: 'docs/pantry.md',
      change: 'rename',
    });
    expect(result).toEqual({ status: 'mod', symbols: [] });
  });

  it.each<[GitChange, Status]>([
    ['mod', 'mod'],
    ['add', 'add'],
    ['del', 'del'],
    ['rename', 'mod'],
  ])('binary-modified: git %s gives %s, no symbols', async (change, status) => {
    const result = await compare({ fixture: 'binary-modified', path: 'assets/logo.png', change, binary: true });
    expect(result).toEqual({ status, symbols: [] });
  });

  it('a binary file with a code extension is still not parsed', async () => {
    const result = await compareFile({ path: 'src/blob.ts', change: 'mod', binary: true, before: 'a', after: 'b' });
    expect(result).toEqual({ status: 'mod', symbols: [] });
  });

  it('empty new TS file: add, no symbols', async () => {
    const result = await compare({ fixture: 'empty-new-ts-file', path: 'src/empty.ts', change: 'add' });
    expect(result).toEqual({ status: 'add', symbols: [] });
  });

  it('renamed-unchanged: file mod, symbols same, ids on the new path', async () => {
    const result = await compare({
      fixture: 'renamed-unchanged',
      path: 'src/measure/cups.ts',
      oldPath: 'src/cups.ts',
      change: 'rename',
    });
    expect(statuses(result.symbols)).toEqual({ 'src/measure/cups.ts#measure': 'same' });
    expect(result.status).toBe('mod');
  });

  it('renamed-and-modified: compared across the old and new path', async () => {
    const result = await compare({
      fixture: 'renamed-and-modified',
      path: 'src/measure/cups.ts',
      oldPath: 'src/cups.ts',
      change: 'rename',
    });
    expect(statuses(result.symbols)).toEqual({ 'src/measure/cups.ts#measure': 'mod' });
    expect(result.status).toBe('mod');
  });

  it('a git mod with identical content (e.g. a mode change) is same', async () => {
    const source = 'export const crumbs = 1;\n';
    const result = await compareFile({ path: 'src/crumbs.ts', change: 'mod', binary: false, before: source, after: source });
    expect(result.status).toBe('same');
  });
});

describe('5.1 matching', () => {
  it('matches on qualified name and kind: a function turned into a class is del + add, ids stay unique', async () => {
    const result = await compareFile({
      path: 'src/tart.ts',
      change: 'mod',
      binary: false,
      before: 'export function Tart() {}\n',
      after: 'export class Tart {}\n',
    });
    expect(result.symbols.map((s) => [s.id, s.name, s.kind, s.status])).toEqual([
      ['src/tart.ts#Tart', 'Tart', 'class', 'add'],
      ['src/tart.ts#Tart~2', 'Tart', 'function', 'del'],
    ]);
    expect(result.status).toBe('add');
  });

  it('export-added-above-function: the unchanged function stays same, only the export is add', async () => {
    const result = await compare({ fixture: 'export-added-above-function', path: 'src/parse.ts', change: 'mod' });
    expect(result.symbols.map((s) => [s.id, s.name, s.kind, s.status])).toEqual([
      ['src/parse.ts#parse', 'parse', 'export', 'add'],
      ['src/parse.ts#parse~2', 'parse', 'function', 'same'],
    ]);
    expect(result.status).toBe('add');
  });

  it('reorder-function-and-export: symbols same, file mod', async () => {
    const result = await compare({ fixture: 'reorder-function-and-export', path: 'src/knead.ts', change: 'mod' });
    expect(result.symbols.map((s) => [s.id, s.kind, s.status])).toEqual([
      ['src/knead.ts#knead', 'export', 'same'],
      ['src/knead.ts#knead~2', 'function', 'same'],
    ]);
    expect(result.status).toBe('mod');
  });

  it('function-added-above-reexport: the re-export stays same, only the function is add', async () => {
    const result = await compare({ fixture: 'function-added-above-reexport', path: 'src/helper.ts', change: 'mod' });
    expect(result.symbols.map((s) => [s.id, s.kind, s.status])).toEqual([
      ['src/helper.ts#helper', 'function', 'add'],
      ['src/helper.ts#helper~2', 'export', 'same'],
    ]);
    expect(result.status).toBe('add');
  });

  it('duplicates of the same kind match by occurrence', async () => {
    const result = await compareFile({
      path: 'db/q.sql',
      change: 'mod',
      binary: false,
      before: 'SELECT 1;\nSELECT 2;\n',
      after: 'SELECT 1;\nSELECT 3;\n',
    });
    expect(result.symbols.map((s) => [s.id, s.status])).toEqual([
      ['db/q.sql#SELECT', 'same'],
      ['db/q.sql#SELECT~2', 'mod'],
    ]);
  });

  it('a deleted symbol gets one non-colliding suffix on its base name, never a second one', async () => {
    const result = await compareFile({
      path: 'src/foo.ts',
      change: 'mod',
      binary: false,
      before: 'function foo() {}\nexport { foo };\nexport class foo2 {}\n',
      after: 'export { foo };\nexport class foo {}\n',
    });
    expect(result.symbols.map((s) => [s.id, s.name, s.kind, s.status])).toEqual([
      ['src/foo.ts#foo', 'foo', 'export', 'same'],
      ['src/foo.ts#foo~3', 'foo', 'function', 'del'],
      ['src/foo.ts#foo~2', 'foo', 'class', 'add'],
      ['src/foo.ts#foo2', 'foo2', 'class', 'del'],
    ]);
    expect(result.symbols.every((s) => !/~\d+~/.test(s.id))).toBe(true);
  });

  it('duplicates keep their ~N suffix in the id but not in the name', async () => {
    const source = 'SELECT 1;\nSELECT 2;\n';
    const result = await compareFile({ path: 'db/q.sql', change: 'add', binary: false, before: null, after: source });
    expect(result.symbols.map((s) => [s.id, s.name])).toEqual([
      ['db/q.sql#SELECT', 'SELECT'],
      ['db/q.sql#SELECT~2', 'SELECT'],
    ]);
  });

  it('members of a duplicated class show the unsuffixed class name', async () => {
    const source = 'class Menu {\n  render() {}\n}\nclass Menu {\n  render() {}\n}\n';
    const result = await compareFile({ path: 'src/menu.ts', change: 'add', binary: false, before: null, after: source });
    expect(result.symbols.map((s) => [s.id, s.name])).toEqual([
      ['src/menu.ts#Menu', 'Menu'],
      ['src/menu.ts#Menu.render', 'Menu.render'],
      ['src/menu.ts#Menu~2', 'Menu'],
      ['src/menu.ts#Menu~2.render', 'Menu.render'],
    ]);
  });

  it('JavaScript files follow the same rules', async () => {
    const result = await compareFile({
      path: 'src/icing.js',
      change: 'mod',
      binary: false,
      before: 'export function pipe(bag) {\n  return bag;\n}\n',
      after: 'export function pipe(bag, tip) {\n  return bag;\n}\n',
    });
    expect(result.symbols.map((s) => [s.id, s.status])).toEqual([['src/icing.js#pipe', 'sig']]);
    expect(result.status).toBe('sig');
  });

  it('symbols are ordered by range start, then id', async () => {
    const result = await compare({ fixture: 'file-add-beats-del', path: 'src/dust.ts', change: 'mod' });
    expect(result.symbols.map((s) => s.range.start)).toEqual([1, 5, 5]);
    expect(result.symbols.map((s) => s.id)).toEqual([
      'src/dust.ts#dust',
      'src/dust.ts#newGlaze',
      'src/dust.ts#oldGlaze',
    ]);
  });
});
