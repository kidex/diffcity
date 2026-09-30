import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareFile } from '../../src/core/diff/status.js';
import type { FileChange, GitChange } from '../../src/core/diff/status.js';
import type { Status, Symbol } from '../../src/core/report/types.js';

// Combinations of SPEC.md 5.1 (ADR-005, ADR-006, ADR-008) that the main
// status fixtures do not cover: TSX, JS variants, SQL migrations, renames with
// a signature change, binaries without content and file-level directives.

function side(fixture: string, name: string): string | null {
  const url = new URL(`../fixtures/status/${fixture}/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : null;
}

function change(path: string, before: string | null, after: string | null, git: GitChange = 'mod', oldPath?: string): FileChange {
  const base: FileChange = { path, change: git, binary: false, before, after };
  return oldPath === undefined ? base : { ...base, oldPath };
}

function statuses(symbols: Symbol[]): Record<string, Status> {
  return Object.fromEntries(symbols.map((s) => [s.id, s.status]));
}

describe('5.1 TSX', () => {
  it('props changed is sig, JSX body changed is mod, new component is add, file is sig', async () => {
    const result = await compareFile(
      change('src/ui/Pie.tsx', side('tsx-component', 'before.tsx'), side('tsx-component', 'after.tsx')),
    );
    expect(statuses(result.symbols)).toEqual({
      'src/ui/Pie.tsx#Crust': 'sig',
      'src/ui/Pie.tsx#Filling': 'mod',
      'src/ui/Pie.tsx#Topping': 'same',
      'src/ui/Pie.tsx#Glaze': 'add',
    });
    const crust = result.symbols.find((s) => s.id === 'src/ui/Pie.tsx#Crust');
    expect(crust?.signatureBefore).toContain('{ size }: { size: number }');
    expect(crust?.signatureAfter).toContain('{ size, golden }: { size: number; golden: boolean }');
    expect(result.status).toBe('sig');
  });

  it('S8 new TSX file: every symbol add', async () => {
    const result = await compareFile(change('src/ui/Pie.tsx', null, side('tsx-component', 'after.tsx'), 'add'));
    expect(result.symbols.map((s) => s.status)).toEqual(['add', 'add', 'add', 'add']);
    expect(result.status).toBe('add');
  });

  it('S9 deleted TSX file: every symbol del', async () => {
    const result = await compareFile(change('src/ui/Pie.tsx', side('tsx-component', 'before.tsx'), null, 'del'));
    expect(result.symbols.map((s) => s.status)).toEqual(['del', 'del', 'del']);
    expect(result.status).toBe('del');
  });
});

describe('5.1 JavaScript variants', () => {
  const before = 'export function pour(jug) {\n  return jug;\n}\n';

  it.each(['src/pour.js', 'src/pour.mjs', 'src/pour.cjs', 'src/pour.jsx'])('%s: body change is mod', async (path) => {
    const result = await compareFile(change(path, before, 'export function pour(jug) {\n  return jug * 2;\n}\n'));
    expect(statuses(result.symbols)).toEqual({ [`${path}#pour`]: 'mod' });
    expect(result.status).toBe('mod');
  });

  it('JS comment-only change is same', async () => {
    const result = await compareFile(
      change('src/pour.js', before, '// pours from the jug\nexport function pour(jug) {\n  // as is\n  return jug;\n}\n'),
    );
    expect(statuses(result.symbols)).toEqual({ 'src/pour.js#pour': 'same' });
    expect(result.status).toBe('same');
  });

  it('JS default value changed is sig', async () => {
    const result = await compareFile(
      change('src/pour.js', 'export function pour(jug = 1) {\n  return jug;\n}\n', 'export function pour(jug = 2) {\n  return jug;\n}\n'),
    );
    expect(result.symbols[0]?.status).toBe('sig');
    expect(result.symbols[0]?.signatureBefore).toContain('jug = 1');
    expect(result.symbols[0]?.signatureAfter).toContain('jug = 2');
  });

  it('JSX in a .jsx file: markup change is mod', async () => {
    const result = await compareFile(
      change(
        'src/Cup.jsx',
        'export function Cup({ tea }) {\n  return <p>{tea}</p>;\n}\n',
        'export function Cup({ tea }) {\n  return <h2>{tea}</h2>;\n}\n',
      ),
    );
    expect(statuses(result.symbols)).toEqual({ 'src/Cup.jsx#Cup': 'mod' });
  });
});

describe('5.1 SQL migrations: sig is impossible', () => {
  it('a column type change inside CREATE TABLE is mod, never sig', async () => {
    const result = await compareFile(
      change(
        'db/migrations/0007_crumbs.sql',
        side('sql-migration-altered', 'before.sql'),
        side('sql-migration-altered', 'after.sql'),
      ),
    );
    expect(statuses(result.symbols)).toEqual({
      'db/migrations/0007_crumbs.sql#CREATE TABLE crumbs': 'mod',
      'db/migrations/0007_crumbs.sql#ALTER TABLE crumbs': 'same',
    });
    expect(result.symbols.some((s) => s.signatureBefore !== undefined || s.signatureAfter !== undefined)).toBe(false);
    expect(result.status).toBe('mod');
  });

  it('S8 new migration: every statement add', async () => {
    const result = await compareFile(change('db/migrations/0008.sql', null, side('sql-migration-altered', 'after.sql'), 'add'));
    expect(result.symbols.map((s) => [s.kind, s.status])).toEqual([
      ['sql', 'add'],
      ['sql', 'add'],
    ]);
    expect(result.status).toBe('add');
  });

  it('S9 deleted migration: every statement del', async () => {
    const result = await compareFile(change('db/migrations/0007.sql', side('sql-migration-altered', 'before.sql'), null, 'del'));
    expect(result.symbols.map((s) => s.status)).toEqual(['del', 'del']);
    expect(result.status).toBe('del');
  });

  it('a changed string literal is mod (spaces inside literals count)', async () => {
    const result = await compareFile(
      change('db/seed.sql', "INSERT INTO crumbs VALUES (1, 'rye');\n", "INSERT INTO crumbs VALUES (1, 'rye  ');\n"),
    );
    expect(result.symbols.map((s) => s.status)).toEqual(['mod']);
  });

  it('a comment added between statements is same', async () => {
    const source = 'CREATE TABLE crumbs (id integer);\nDROP TABLE old_crumbs;\n';
    const result = await compareFile(
      change('db/0009.sql', source, 'CREATE TABLE crumbs (id integer);\n-- cleanup\nDROP TABLE old_crumbs;\n'),
    );
    expect(result.symbols.map((s) => s.status)).toEqual(['same', 'same']);
    expect(result.status).toBe('same');
  });
});

describe('5.1 renames', () => {
  it('rename plus a parameter added: sig with signatures, ids on the new path', async () => {
    const result = await compareFile(
      change(
        'src/kitchen/portion.ts',
        side('rename-with-sig', 'before.ts'),
        side('rename-with-sig', 'after.ts'),
        'rename',
        'src/portion.ts',
      ),
    );
    expect(result.symbols).toEqual([
      {
        id: 'src/kitchen/portion.ts#portion',
        name: 'portion',
        kind: 'function',
        status: 'sig',
        range: { start: 1, end: 3 },
        signatureBefore: 'export function portion(weight: number): number',
        signatureAfter: 'export function portion(weight: number, slices: number): number',
      },
      {
        id: 'src/kitchen/portion.ts#label',
        name: 'label',
        kind: 'function',
        status: 'same',
        range: { start: 5, end: 7 },
      },
    ]);
    expect(result.status).toBe('sig');
  });

  it('rename .js to .ts with identical code: symbols same, file mod', async () => {
    const source = 'export function stir(pot) {\n  return pot;\n}\n';
    const result = await compareFile(change('src/stir.ts', source, source, 'rename', 'src/stir.js'));
    expect(statuses(result.symbols)).toEqual({ 'src/stir.ts#stir': 'same' });
    expect(result.status).toBe('mod');
  });

  it('rename with whitespace-only changes: symbols same, file mod (ADR-008)', async () => {
    const result = await compareFile(
      change('src/b.ts', 'export const cup = 1;\n', 'export const  cup =  1;\n\n', 'rename', 'src/a.ts'),
    );
    expect(statuses(result.symbols)).toEqual({ 'src/b.ts#cup': 'same' });
    expect(result.status).toBe('mod');
  });
});

describe('5.1 binary files', () => {
  it.each<[GitChange, Status]>([
    ['add', 'add'],
    ['del', 'del'],
  ])('binary %s with no content read: %s, no symbols', async (git, status) => {
    const result = await compareFile({ path: 'assets/bun.webp', change: git, binary: true, before: null, after: null });
    expect(result).toEqual({ status, symbols: [] });
  });
});

describe('5.1 whitespace, comments and directives at file level (ADR-005, ADR-008)', () => {
  it('a @ts-nocheck added above the first symbol is a leading directive: symbol mod, file mod', async () => {
    const result = await compareFile(
      change('src/door.ts', side('file-directive-added', 'before.ts'), side('file-directive-added', 'after.ts')),
    );
    expect(statuses(result.symbols)).toEqual({ 'src/door.ts#knock': 'mod' });
    expect(result.status).toBe('mod');
  });

  it('a directive after the last symbol: symbol same, file mod through the whole-file fallback', async () => {
    const before = 'export function knock(door: string): string {\n  return door;\n}\n';
    const result = await compareFile(change('src/door.ts', before, `${before}/* eslint-disable */\n`));
    expect(statuses(result.symbols)).toEqual({ 'src/door.ts#knock': 'same' });
    expect(result.status).toBe('mod');
  });

  it('a plain comment after the last symbol is same', async () => {
    const before = 'export function knock(door: string): string {\n  return door;\n}\n';
    const result = await compareFile(change('src/door.ts', before, `${before}// end of door\n`));
    expect(result.status).toBe('same');
  });

  it.each([
    ['/* eslint-disable */', 'eslint-disable block'],
    ['// prettier-ignore', 'prettier-ignore'],
    ['// @ts-expect-error', '@ts-expect-error'],
  ])('file-level directive %s added gives file mod', async (directive) => {
    const before = 'export const oven = 180;\n';
    const result = await compareFile(change('src/oven.ts', before, `${directive}\n${before}`));
    expect(result.status).toBe('mod');
  });

  it('a directive changed to a different rule gives mod', async () => {
    const result = await compareFile(
      change(
        'src/tray.ts',
        '// eslint-disable-next-line no-console\nexport const tray = 1;\n',
        '// eslint-disable-next-line no-alert\nexport const tray = 1;\n',
      ),
    );
    expect(result.status).toBe('mod');
  });

  it('a directive removed from a body gives mod', async () => {
    const result = await compareFile(
      change('src/score.ts', side('directive-comment-added', 'after.ts'), side('directive-comment-added', 'before.ts')),
    );
    expect(statuses(result.symbols)).toEqual({ 'src/score.ts#score': 'mod' });
    expect(result.status).toBe('mod');
  });

  it('a plain comment added at file level is same', async () => {
    const before = 'export const oven = 180;\n';
    const result = await compareFile(change('src/oven.ts', before, `// preheat first\n${before}`));
    expect(result.status).toBe('same');
  });

  it('CRLF line endings only is same', async () => {
    const before = 'export function rise(time: number): number {\n  return time * 2;\n}\n';
    const result = await compareFile(change('src/rise.ts', before, before.replace(/\n/g, '\r\n')));
    expect(statuses(result.symbols)).toEqual({ 'src/rise.ts#rise': 'same' });
    expect(result.status).toBe('same');
  });

  it('whitespace and a comment inside the signature are same, not sig', async () => {
    const result = await compareFile(
      change(
        'src/rise.ts',
        'export function rise(time: number): number {\n  return time;\n}\n',
        'export function rise( time : number /* minutes */ ) : number {\n  return time;\n}\n',
      ),
    );
    expect(statuses(result.symbols)).toEqual({ 'src/rise.ts#rise': 'same' });
    expect(result.status).toBe('same');
  });

  it('an added semicolon is mod (semicolons are tokens)', async () => {
    const result = await compareFile(
      change(
        'src/rise.ts',
        'export function rise(time: number): number {\n  return time\n}\n',
        'export function rise(time: number): number {\n  return time;\n}\n',
      ),
    );
    expect(statuses(result.symbols)).toEqual({ 'src/rise.ts#rise': 'mod' });
  });

  it('spaces inside a template literal count: mod', async () => {
    const result = await compareFile(
      change('src/tag.ts', 'export function tag(n: string) {\n  return `#${n}`;\n}\n', 'export function tag(n: string) {\n  return `# ${n}`;\n}\n'),
    );
    expect(statuses(result.symbols)).toEqual({ 'src/tag.ts#tag': 'mod' });
  });
});

describe('5.1 heaviest status, remaining pairs', () => {
  it('sig + del gives sig; del + mod gives del', async () => {
    const before = 'export function a(x: number) {\n  return x;\n}\nexport function b() {\n  return 1;\n}\nexport function c() {\n  return 1;\n}\n';
    const sigDel = await compareFile(change('src/abc.ts', before, 'export function a(x: string) {\n  return x;\n}\nexport function c() {\n  return 1;\n}\n'));
    expect(statuses(sigDel.symbols)).toEqual({ 'src/abc.ts#a': 'sig', 'src/abc.ts#b': 'del', 'src/abc.ts#c': 'same' });
    expect(sigDel.status).toBe('sig');

    const delMod = await compareFile(change('src/abc.ts', before, 'export function a(x: number) {\n  return x + 1;\n}\nexport function c() {\n  return 1;\n}\n'));
    expect(statuses(delMod.symbols)).toEqual({ 'src/abc.ts#a': 'mod', 'src/abc.ts#b': 'del', 'src/abc.ts#c': 'same' });
    expect(delMod.status).toBe('del');
  });
});
