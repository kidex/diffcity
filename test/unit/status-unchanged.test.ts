import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareFile, unchangedSymbols } from '../../src/core/diff/status.js';

function fixture(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');
}

describe('unchangedSymbols (untouched files in the report, ADR-011)', () => {
  it.each([
    ['parse/duplicate-names/input.js', 'src/menu.js'],
    ['parse/kind-method/input.ts', 'src/pantry.ts'],
    ['status/kind-sql/after.sql', 'db/orders.sql'],
    ['parse/tsx-component/input.tsx', 'src/Card.tsx'],
  ])('%s: every symbol same, ids and order as compareFile gives them', async (file, path) => {
    const source = fixture(file);
    const symbols = await unchangedSymbols(path, source);
    const compared = await compareFile({ path, change: 'mod', binary: false, before: source, after: source });
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols).toEqual(compared.symbols);
    expect(symbols.every((symbol) => symbol.status === 'same')).toBe(true);
    expect(symbols.every((symbol) => symbol.id.startsWith(`${path}#`))).toBe(true);
  });

  it('returns no symbols for an unsupported language', async () => {
    expect(await unchangedSymbols('docs/menu.md', '# Menu\n')).toEqual([]);
  });
});
