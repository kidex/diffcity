import { describe, expect, it } from 'vitest';
import { parseFile } from '../../src/core/parse/file.js';
import { extractSymbols } from '../../src/core/parse/typescript.js';
import { extractSqlSymbols } from '../../src/core/parse/sql.js';

async function normalized(source: string, language: Parameters<typeof parseFile>[1]): Promise<string> {
  return (await parseFile(source, language)).normalized;
}

describe('parseFile: whole-file normal form (ADR-005, ADR-008)', () => {
  it('ignores whitespace, line breaks and plain comments', async () => {
    const a = await normalized('import { a } from "./a";\nexport const x = a + 1;\n', 'typescript');
    const b = await normalized(
      '// header\nimport {a} from "./a";\n\n/** jsdoc */\nexport const x =\n  a + 1; /* tail */\n',
      'typescript',
    );
    expect(b).toBe(a);
  });

  it('keeps directive comments as tokens', async () => {
    const a = await normalized('const x = 1;\n', 'typescript');
    const b = await normalized('// @ts-ignore\nconst x = 1;\n', 'typescript');
    const c = await normalized('/* eslint-disable */\nconst x = 1;\n', 'javascript');
    expect(b).not.toBe(a);
    expect(c).not.toBe(await normalized('const x = 1;\n', 'javascript'));
  });

  it('keeps whitespace inside string and template literals', async () => {
    expect(await normalized('const s = "a b";', 'typescript')).not.toBe(await normalized('const s = "a  b";', 'typescript'));
    expect(await normalized('const s = `a b`;', 'typescript')).not.toBe(await normalized('const s = `a  b`;', 'typescript'));
  });

  it('semicolons and trailing commas are tokens', async () => {
    expect(await normalized('const x = [1, 2];', 'typescript')).not.toBe(
      await normalized('const x = [1, 2,];', 'typescript'),
    );
    expect(await normalized('const x = 1;', 'typescript')).not.toBe(await normalized('const x = 1', 'typescript'));
  });

  it('SQL: comments and whitespace outside literals are ignored', async () => {
    const a = await normalized('CREATE TABLE pantry (id int);', 'sql');
    const b = await normalized('-- note\nCREATE   TABLE pantry (\n  id int /* key */\n);\n', 'sql');
    expect(b).toBe(a);
    expect(await normalized("SELECT 'a b';", 'sql')).not.toBe(await normalized("SELECT 'a  b';", 'sql'));
  });

  it('returns the same symbols as the per-language extractors', async () => {
    const ts = 'export function bake(n: number): number {\n  return n;\n}\n';
    expect((await parseFile(ts, 'typescript')).symbols).toEqual(await extractSymbols(ts, 'typescript'));
    const sql = 'CREATE TABLE pantry (id int);\nSELECT 1;\n';
    expect((await parseFile(sql, 'sql')).symbols).toEqual(extractSqlSymbols(sql));
  });
});
