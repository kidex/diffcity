// The file-size rule (ADR-030) over invented files of a `ledger` repo.

import { describe, expect, it } from 'vitest';
import type { Symbol } from '../../../src/core/report/types.js';
import { mergeRules, runRules, type RuleFile } from '../../../src/core/rules/index.js';

const AT = '2026-05-06T07:08:09.000Z';

function run(rule: Record<string, unknown>, files: RuleFile[]): ReturnType<typeof runRules> {
  return runRules(mergeRules({ settings: [{ id: 'size', kind: 'file-size', ...rule }] }), files, AT);
}

function file(path: string, extra: Partial<RuleFile> = {}): RuleFile {
  return { path, status: 'mod', symbols: [], after: { bytes: 100, lines: 10 }, ...extra };
}

function fn(name: string, start: number, end: number, status: Symbol['status'] = 'mod'): Symbol {
  return { id: `src/ledger/post.ts#${name}`, name, kind: 'function', status, range: { start, end } };
}

describe('file-size', () => {
  it('file-size/lines-over: a touched file over maxLines; at the limit it passes', () => {
    const { findings, checks } = run({ maxLines: 300 }, [
      file('src/ledger/post.ts', { after: { bytes: 9000, lines: 301 } }),
      file('src/ledger/balance.ts', { after: { bytes: 9000, lines: 300 } }),
      // Not counted (binary): nothing to say about lines.
      file('assets/logo.png', { after: { bytes: 9000, lines: null } }),
    ]);
    expect(findings.map((finding) => [finding.file, finding.title, finding.message])).toEqual([
      ['src/ledger/post.ts', 'File over 300 lines', 'src/ledger/post.ts has 301 lines; the limit is 300 lines.'],
    ]);
    expect(checks[0]).toMatchObject({ state: 'violations', findings: 1 });
  });

  it('file-size/bytes-over: a touched file over maxBytes, binary or not; severity follows the rule', () => {
    const { findings } = run({ maxBytes: 1024, severity: 'high' }, [
      file('assets/ledger.pdf', { after: { bytes: 4096, lines: null } }),
      file('src/ledger/post.ts', { after: { bytes: 1024, lines: 10 } }),
    ]);
    expect(findings.map((finding) => [finding.file, finding.line, finding.severity, finding.title])).toEqual([
      ['assets/ledger.pdf', 0, 'high', 'File over 1024 bytes'],
    ]);
  });

  it('file-size/symbol-lines-over: each after-version symbol over maxSymbolLines, on its first line', () => {
    const { findings } = run({ maxSymbolLines: 10 }, [
      file('src/ledger/post.ts', {
        symbols: [fn('postEntry', 5, 15), fn('reverseEntry', 20, 29), fn('legacyPost', 1, 80, 'del'), fn('settle', 40, 52, 'same')],
      }),
    ]);
    expect(findings.map((finding) => [finding.line, finding.title, finding.message, finding.symbolId])).toEqual([
      [5, 'Function postEntry over 10 lines', 'postEntry spans 11 lines (lines 5-15); the limit is 10 lines.', 'src/ledger/post.ts#postEntry'],
      [40, 'Function settle over 10 lines', 'settle spans 13 lines (lines 40-52); the limit is 10 lines.', 'src/ledger/post.ts#settle'],
    ]);
  });

  it('file-size/untouched-ignored: untouched files and deleted files are never checked', () => {
    const { findings, checks } = run({ maxLines: 1, maxBytes: 1, maxSymbolLines: 1 }, [
      file('src/ledger/old.ts', { status: 'same', after: { bytes: 9000, lines: 900 }, symbols: [fn('old', 1, 900, 'same')] }),
      file('src/ledger/gone.ts', { status: 'del', after: null, symbols: [fn('gone', 1, 900, 'del')] }),
    ]);
    expect(findings).toEqual([]);
    expect(checks[0]).toMatchObject({ state: 'passed', findings: 0 });
  });

  it('file-size/include-exclude: only included paths, minus the excluded ones', () => {
    const big = { after: { bytes: 1, lines: 900 } };
    const files = [
      file('src/ledger/post.ts', big),
      file('src/ledger/post.test.ts', big),
      file('src/report/summary.ts', big),
      file('scripts/seed.ts', big),
    ];
    const paths = (rule: Record<string, unknown>): string[] => run({ maxLines: 100, ...rule }, files).findings.map((finding) => finding.file);
    expect(paths({})).toEqual(['scripts/seed.ts', 'src/ledger/post.test.ts', 'src/ledger/post.ts', 'src/report/summary.ts']);
    expect(paths({ include: ['src/'] })).toEqual(['src/ledger/post.test.ts', 'src/ledger/post.ts', 'src/report/summary.ts']);
    expect(paths({ include: ['src/'], exclude: ['**/*.test.ts', 'src/report'] })).toEqual(['src/ledger/post.ts']);
    expect(paths({ include: ['src/*/post.ts'] })).toEqual(['src/ledger/post.ts']);
  });
});
