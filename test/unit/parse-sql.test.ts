import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractSqlSymbols } from '../../src/core/parse/sql.js';

function fixture(name: string, file = 'input.sql'): string {
  return readFileSync(new URL(`../fixtures/sql/${name}/${file}`, import.meta.url), 'utf8');
}

function outline(source: string): Array<[string, number, number]> {
  return extractSqlSymbols(source).map((s) => [s.qualifiedName, s.range.start, s.range.end]);
}

describe('extractSqlSymbols', () => {
  it('sql/kind-sql: one sql symbol per statement, named verb plus object', () => {
    const symbols = extractSqlSymbols(fixture('kind-sql'));
    expect(symbols.map((s) => [s.name, s.range.start, s.range.end])).toEqual([
      ['CREATE TABLE orders', 3, 6],
      ['ALTER TABLE orders', 8, 8],
      ['CREATE INDEX orders_discount_idx', 11, 12],
      ['CREATE FUNCTION pastry.apply_discount', 14, 17],
      ['CREATE MATERIALIZED VIEW pastry."Daily Totals"', 19, 19],
      ['INSERT INTO pastry.order_status', 20, 20],
      ['DROP TABLE legacy_coupons', 21, 21],
      ['COMMENT ON COLUMN orders.discount', 22, 22],
      ['CREATE INDEX ON orders', 23, 23],
      ['GRANT SELECT', 24, 24],
      ['DO', 25, 25],
    ]);
    for (const s of symbols) {
      expect(s.kind).toBe('sql');
      expect(s.qualifiedName).toBe(s.name);
      expect(s.signature).toBe('');
      expect(s.signatureText).toBe('');
    }
  });

  it('sql/semicolon-in-string: does not split inside strings, identifiers, comments or dollar quotes', () => {
    expect(outline(fixture('semicolon-in-string'))).toEqual([
      ['INSERT INTO croissant_notes', 1, 1],
      ['INSERT INTO croissant_notes~2', 2, 2],
      ['CREATE TABLE "odd;name"', 3, 3],
      ['CREATE FUNCTION bake_count', 6, 11],
      ['CREATE FUNCTION glaze_count', 12, 17],
      ['SELECT', 18, 18],
    ]);
  });

  it('sql/semicolon-in-string: keeps literals verbatim in the body', () => {
    const symbols = extractSqlSymbols(fixture('semicolon-in-string'));
    expect(symbols[0]?.body).toBe(
      "INSERT INTO croissant_notes ( body ) VALUES ( 'flaky; buttery; ''golden''' ) ;",
    );
    expect(symbols[1]?.body).toContain("E'escaped \\'; still inside'");
    expect(symbols[4]?.body).toContain('$glaze$\nBEGIN\n  EXECUTE $$SELECT 1;$$;\n  RETURN 3;\nEND;\n$glaze$');
  });

  it('sql/duplicate-statement: repeated names get ~2, ~3 in source order', () => {
    expect(outline(fixture('duplicate-statement')).map(([name]) => name)).toEqual([
      'INSERT INTO muffin_flavors',
      'INSERT INTO muffin_flavors~2',
      'INSERT INTO muffin_flavors~3',
      'CREATE TABLE muffin_trays',
    ]);
    expect(extractSqlSymbols(fixture('duplicate-statement')).map((s) => s.name)).toEqual([
      'INSERT INTO muffin_flavors',
      'INSERT INTO muffin_flavors',
      'INSERT INTO muffin_flavors',
      'CREATE TABLE muffin_trays',
    ]);
  });

  it('sql/whitespace-comment-only: bodies are equal when only whitespace and comments change', () => {
    const before = extractSqlSymbols(fixture('whitespace-comment-only', 'before.sql'));
    const after = extractSqlSymbols(fixture('whitespace-comment-only', 'after.sql'));
    expect(after.map((s) => s.name)).toEqual(before.map((s) => s.name));
    expect(after.map((s) => s.body)).toEqual(before.map((s) => s.body));
    expect(after.map((s) => s.range)).toEqual([
      { start: 2, end: 6 },
      { start: 9, end: 10 },
    ]);
    expect(after[1]?.body).toBe('ALTER TABLE baguette_batches ADD COLUMN baked_at timestamptz ;');
  });

  it('whitespace inside a literal still counts', () => {
    const [a] = extractSqlSymbols("INSERT INTO scone_tags VALUES ('a b');");
    const [b] = extractSqlSymbols("INSERT INTO scone_tags VALUES ('a  b');");
    expect(a?.body).not.toBe(b?.body);
  });

  it('ignores empty statements and comment-only files', () => {
    expect(extractSqlSymbols('')).toEqual([]);
    expect(extractSqlSymbols('-- nothing here\n/* nor here */\n;;\n')).toEqual([]);
  });

  it('names other statement shapes sensibly', () => {
    const names = extractSqlSymbols(
      [
        'ALTER TABLE IF EXISTS ONLY public.tart_sizes ADD COLUMN x int;',
        'DROP INDEX CONCURRENTLY IF EXISTS tart_sizes_idx;',
        'UPDATE ONLY tart_sizes SET x = 1;',
        'DELETE FROM tart_sizes WHERE x = $1;',
        'TRUNCATE TABLE tart_sizes;',
        'create temporary table tart_scratch (id int);',
        'CREATE TRIGGER tart_touch BEFORE UPDATE ON tart_sizes FOR EACH ROW EXECUTE FUNCTION touch();',
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
        'SET search_path = pastry;',
        'BEGIN;',
        "CREATE TABLE U&\"d\\0061ta\" (id int);",
        'CREATE TABLE `tart_mysql` (id int);',
      ].join('\n'),
    ).map((s) => s.name);
    expect(names).toEqual([
      'ALTER TABLE public.tart_sizes',
      'DROP INDEX tart_sizes_idx',
      'UPDATE tart_sizes',
      'DELETE FROM tart_sizes',
      'TRUNCATE tart_sizes',
      'CREATE TABLE tart_scratch',
      'CREATE TRIGGER tart_touch',
      'CREATE EXTENSION "uuid-ossp"',
      'SET SEARCH_PATH',
      'BEGIN',
      'CREATE TABLE U&"d\\0061ta"',
      'CREATE TABLE `tart_mysql`',
    ]);
  });

  it('survives unterminated strings, comments and dollar quotes', () => {
    expect(outline("INSERT INTO eclair_log VALUES ('open;\n")).toEqual([['INSERT INTO eclair_log', 1, 1]]);
    expect(outline('CREATE TABLE eclair_a (id int); /* open; comment')).toEqual([['CREATE TABLE eclair_a', 1, 1]]);
    expect(outline('DO $x$ unterminated; body')).toEqual([['DO', 1, 1]]);
  });
});
