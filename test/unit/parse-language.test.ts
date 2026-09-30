import { describe, expect, it } from 'vitest';
import { languageForPath } from '../../src/core/parse/language.js';

describe('languageForPath', () => {
  it.each([
    ['src/ledger.ts', 'typescript'],
    ['src/ledger.mts', 'typescript'],
    ['src/ledger.cts', 'typescript'],
    ['types/ledger.d.ts', 'typescript'],
    ['ui/Card.tsx', 'tsx'],
    ['lib/pebbles.js', 'javascript'],
    ['lib/Card.jsx', 'javascript'],
    ['lib/pebbles.mjs', 'javascript'],
    ['lib/pebbles.cjs', 'javascript'],
    ['db/001_orders.sql', 'sql'],
    ['DB/001_ORDERS.SQL', 'sql'],
    ['ui/Card.TSX', 'tsx'],
  ] as const)('%s -> %s', (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each(['README.md', 'package.json', 'Dockerfile', 'styles.css', '.ts', 'src/ts', 'src/ledger.ts.bak'])(
    '%s -> null',
    (path) => {
      expect(languageForPath(path)).toBeNull();
    },
  );
});
