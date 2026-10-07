import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOwn, parseSarif } from '../../../src/core/findings/index.js';

const doc = readFileSync(new URL('../../../docs/findings.md', import.meta.url), 'utf8');

function jsonBlocks(): unknown[] {
  return [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1] ?? '') as unknown);
}

describe('findings', () => {
  it('docs-examples-parse', () => {
    const blocks = jsonBlocks();
    expect(blocks).toHaveLength(2);
    const own = blocks.find((block) => Array.isArray(block));
    const sarif = blocks.find((block) => !Array.isArray(block));
    const ownResult = parseOwn(own, '/work/shopfront');
    expect(ownResult.ok && ownResult.findings.map((f) => f.source)).toEqual(['claude', 'claude']);
    expect(ownResult.ok && ownResult.warnings).toEqual([]);
    const sarifResult = parseSarif(sarif, '/work/shopfront');
    expect(sarifResult.ok && sarifResult.findings).toEqual([
      expect.objectContaining({ source: 'semgrep', severity: 'high', category: 'security', line: 14, fix: 'Check the order first.' }),
    ]);
    expect(sarifResult.ok && sarifResult.warnings).toEqual([]);
  });
});
