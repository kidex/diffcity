import { describe, expect, it } from 'vitest';
import { extractSqlSymbols } from '../../src/core/parse/sql.js';

const names = (source: string): string[] => extractSqlSymbols(source).map((s) => s.name);
const bodies = (source: string): string[] => extractSqlSymbols(source).map((s) => s.body);

describe('extractSqlSymbols: statement splitting (PostgreSQL)', () => {
  it('backslash does not escape in a plain string, so the string ends at the quote', () => {
    expect(names("INSERT INTO pie_paths VALUES ('C:\\crust\\'); SELECT 2;")).toEqual([
      'INSERT INTO pie_paths',
      'SELECT',
    ]);
  });

  it('comment markers inside strings and quoted identifiers are not comments', () => {
    expect(
      names(
        [
          "INSERT INTO pie_notes VALUES ('-- not a comment; really');",
          "INSERT INTO pie_notes VALUES ('/* not; a comment');",
          'CREATE TABLE "pie--odd/*name" (id int);',
          'SELECT 3;',
        ].join('\n'),
      ),
    ).toEqual(['INSERT INTO pie_notes', 'INSERT INTO pie_notes~2', 'CREATE TABLE "pie--odd/*name"', 'SELECT']);
  });

  it('a dollar tag only closes on the identical tag', () => {
    const source = [
      'CREATE FUNCTION pie_a() RETURNS text AS $pie$',
      "  SELECT $pi$; $pie_x$; 'x';",
      '$pie$ LANGUAGE sql;',
      'SELECT 4;',
    ].join('\n');
    const symbols = extractSqlSymbols(source);
    expect(symbols.map((s) => [s.name, s.range.start, s.range.end])).toEqual([
      ['CREATE FUNCTION pie_a', 1, 3],
      ['SELECT', 4, 4],
    ]);
  });

  it('positional parameters are not dollar quotes', () => {
    expect(names('SELECT $1; SELECT $2;')).toEqual(['SELECT', 'SELECT~2']);
  });

  it('an identifier containing $$ is not a dollar quote', () => {
    expect(names('CREATE TABLE tart$$price (id int); SELECT 5;')).toEqual([
      'CREATE TABLE tart$$price',
      'SELECT',
    ]);
  });

  it('a line comment ends at the newline, CRLF included', () => {
    const symbols = extractSqlSymbols('-- head; note\r\nCREATE TABLE pie_rows (id int);\r\nSELECT 6;\r\n');
    expect(symbols.map((s) => [s.name, s.range.start, s.range.end])).toEqual([
      ['CREATE TABLE pie_rows', 2, 2],
      ['SELECT', 3, 3],
    ]);
  });
});

describe('extractSqlSymbols: names and duplicates', () => {
  it('duplicate numbering is per name, in source order', () => {
    expect(
      names(
        [
          'ALTER TABLE pie_orders ADD COLUMN a int;',
          'CREATE INDEX pie_orders_a_idx ON pie_orders (a);',
          'ALTER TABLE pie_orders ADD COLUMN b int;',
          'ALTER TABLE pie_crusts ADD COLUMN c int;',
          'ALTER TABLE pie_orders ADD COLUMN d int;',
        ].join('\n'),
      ),
    ).toEqual([
      'ALTER TABLE pie_orders',
      'CREATE INDEX pie_orders_a_idx',
      'ALTER TABLE pie_orders~2',
      'ALTER TABLE pie_crusts',
      'ALTER TABLE pie_orders~3',
    ]);
  });

  it('the verb is uppercased whatever the source case', () => {
    expect(names('alter table pie_orders add column e int;\ncreate index pie_e_idx on pie_orders (e);')).toEqual([
      'ALTER TABLE pie_orders',
      'CREATE INDEX pie_e_idx',
    ]);
  });
});

describe('extractSqlSymbols: body normalization', () => {
  it('whitespace, tabs, CRLF and comments outside literals do not change the body', () => {
    const compact = 'CREATE TABLE pie_sizes(id int,label text DEFAULT \'x\');';
    const spread =
      '/* lead */ CREATE\tTABLE\r\n  pie_sizes (\r\n    id int , -- key\r\n    label text /* shown */ DEFAULT \'x\'\r\n  ) ;';
    expect(bodies(spread)).toEqual(bodies(compact));
  });

  it('a comment separates tokens like whitespace, it does not glue them', () => {
    const [glued] = bodies('SELECT 1/* gap */2;');
    const [joined] = bodies('SELECT 12;');
    expect(glued).not.toBe(joined);
    expect(glued).toBe(bodies('SELECT 1 2;')[0]);
  });

  it('whitespace inside a quoted identifier or dollar-quoted literal still counts', () => {
    expect(bodies('CREATE TABLE "pie a" (id int);')).not.toEqual(bodies('CREATE TABLE "pie  a" (id int);'));
    expect(bodies('DO $$ SELECT 1 $$;')).not.toEqual(bodies('DO $$  SELECT 1 $$;'));
  });

  it('comment text inside a literal counts', () => {
    expect(bodies("INSERT INTO pie_notes VALUES ('a -- b');")).not.toEqual(
      bodies("INSERT INTO pie_notes VALUES ('a');"),
    );
  });

  it('a real change outside literals changes the body', () => {
    expect(bodies('ALTER TABLE pie_orders ADD COLUMN f int;')).not.toEqual(
      bodies('ALTER TABLE pie_orders ADD COLUMN f bigint;'),
    );
  });
});

describe('extractSqlSymbols: no signature (never sig)', () => {
  it('every statement shape yields an empty signature, before and after a change', () => {
    const before = extractSqlSymbols(
      'CREATE FUNCTION pie_total(a int) RETURNS int AS $$ SELECT a $$ LANGUAGE sql;\nCREATE TABLE pie_g (id int);',
    );
    const after = extractSqlSymbols(
      'CREATE FUNCTION pie_total(a bigint, b int) RETURNS bigint AS $$ SELECT a + b $$ LANGUAGE sql;\nCREATE TABLE pie_g (id bigint, x text);',
    );
    for (const s of [...before, ...after]) {
      expect(s.kind).toBe('sql');
      expect(s.signature).toBe('');
      expect(s.signatureText).toBe('');
    }
    expect(after.map((s) => s.name)).toEqual(before.map((s) => s.name));
    expect(after.map((s) => s.signature)).toEqual(before.map((s) => s.signature));
    expect(after.map((s) => s.body)).not.toEqual(before.map((s) => s.body));
  });
});
