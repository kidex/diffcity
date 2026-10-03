// The markdown summary of "Needs rewrite" marks (ADR-028).

import { describe, expect, it } from 'vitest';
import type { ReviewMark } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { renderSummary, SUMMARY_MAX_BYTES } from '../../../src/core/review/index.js';
import { file, sampleReport, sym, T } from './review-helpers.js';

const base = { ref: 'branch:feature/totals', repoName: 'sample-shop', head: 'abcdef0123456789' };
const TITLE = '# Review of branch:feature/totals in sample-shop (head abcdef0)';

function mark(kind: 'file' | 'symbol', id: string, overrides: Partial<ReviewMark> = {}): ReviewMark {
  return {
    targetKind: kind,
    targetId: id,
    filePath: 'src/cart/total.ts',
    mark: 'rewrite',
    note: 'redo this',
    lines: null,
    state: 'current',
    createdAt: T,
    updatedAt: T,
    outdatedAt: null,
    ...overrides,
  };
}

/** The lines that are, or would render as, a heading. */
const headingLines = (text: string): string[] => text.split('\n').filter((line) => line.trimStart().startsWith('#'));

describe('summary/rewrite-only', () => {
  it('lists current rewrite marks only, with the header and the general note', () => {
    const text = renderSummary({
      ...base,
      note: 'Mostly fine, two things to redo.',
      report: sampleReport(),
      marks: [
        mark('symbol', 's-total', { note: 'Handle empty carts.' }),
        mark('file', 'f-tax', { note: 'Split the file.' }),
        mark('symbol', 's-round', { mark: 'good', note: null }),
        mark('symbol', 's-rate', { state: 'outdated', outdatedAt: T }),
        mark('file', 'f-total', { mark: 'checked', note: null }),
      ],
    });
    expect(text).toBe(
      [
        TITLE,
        '',
        'Mostly fine, two things to redo.',
        '',
        '## Needs rewrite (2)',
        '',
        '### src/cart/total.ts',
        '- `total`: Handle empty carts.',
        '',
        '### src/cart/tax.ts',
        '- Whole file: Split the file.',
        '',
      ].join('\n'),
    );
  });

  it('without a general note or marks: header and an empty section', () => {
    expect(renderSummary({ ...base, note: null, report: sampleReport(), marks: [] })).toBe(`${TITLE}\n\n## Needs rewrite (0)\n`);
  });
});

describe('summary/report-order', () => {
  it('files come in Report order and symbols in floor order, whatever the order of the marks', () => {
    const text = renderSummary({
      ...base,
      note: null,
      report: sampleReport(),
      marks: [
        mark('symbol', 's-rate', { note: 'r' }),
        mark('file', 'f-total', { note: 'whole' }),
        mark('symbol', 's-round', { note: 'b' }),
        mark('symbol', 's-total', { note: 'a' }),
      ],
    });
    expect(text.split('\n').filter((line) => line.startsWith('###') || line.startsWith('- '))).toEqual([
      '### src/cart/total.ts',
      '- `total`: a',
      '- `roundCents`: b',
      '- Whole file: whole',
      '### src/cart/tax.ts',
      '- `taxRate`: r',
    ]);
  });
});

describe('summary/line-range', () => {
  it('a range shows as "lines start–end" on a symbol and a whole-file bullet', () => {
    const text = renderSummary({
      ...base,
      note: null,
      report: sampleReport(),
      marks: [
        mark('symbol', 's-total', { note: 'a', lines: { side: 'new', start: 4, end: 9 } }),
        mark('file', 'f-total', { note: 'b', lines: { side: 'old', start: 1, end: 2 } }),
      ],
    });
    expect(text).toContain('- `total`, lines 4–9: a\n');
    expect(text).toContain('- Whole file, lines 1–2: b\n');
  });
});

describe('summary/note-cannot-break-structure', () => {
  it('a note with "\\n## Injected" and "\\n# Title" stays under its bullet', () => {
    const hostile = 'first line\n## Injected\n# Title\n   # indented heading\r\n### Third';
    const text = renderSummary({
      ...base,
      note: 'general\n## Injected general\n# Title general',
      report: sampleReport(),
      marks: [mark('symbol', 's-total', { note: hostile }), mark('file', 'f-tax', { note: hostile })],
    });
    // Only the structure the renderer wrote: the title, the section and one heading per file.
    expect(headingLines(text)).toEqual([TITLE, '## Needs rewrite (2)', '### src/cart/total.ts', '### src/cart/tax.ts']);
    const lines = text.split('\n');
    const start = lines.indexOf('- `total`: first line');
    expect(lines.slice(start, start + 5)).toEqual([
      '- `total`: first line',
      '  \\## Injected',
      '  \\# Title',
      '     \\# indented heading',
      '  \\### Third',
    ]);
    // The general note, a paragraph of its own, cannot open a section either.
    expect(lines).toContain('\\## Injected general');
    expect(lines).toContain('\\# Title general');
  });

  it('a header field with line breaks stays one line', () => {
    const text = renderSummary({ ...base, ref: 'branch:x\n## Evil', note: null, report: sampleReport(), marks: [] });
    expect(text.split('\n')[0]).toBe('# Review of branch:x ## Evil in sample-shop (head abcdef0)');
  });
});

describe('summary/cap-32k', () => {
  it('past 32 KiB it stops and says how many notes are not shown', () => {
    const files = Array.from({ length: 40 }, (_, f) =>
      file(
        `f${String(f)}`,
        `src/gen/file-${String(f)}.ts`,
        'mod',
        'ok',
        Array.from({ length: 10 }, (_, s) => sym(`f${String(f)}s${String(s)}`, `fn${String(s)}`)),
      ),
    );
    const report: Report = { ...sampleReport(), packages: [{ id: 'p', path: 'src/gen', tier1: false, files }] };
    const note = 'n'.repeat(1900);
    const marks = files.flatMap((f) => f.symbols.map((s) => mark('symbol', s.id, { note })));
    expect(marks).toHaveLength(400);
    const text = renderSummary({ ...base, note: null, report, marks });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    const shown = text.split('\n').filter((line) => line.startsWith('- ')).length;
    expect(shown).toBeGreaterThan(10);
    expect(shown).toBeLessThan(400);
    expect(text.trimEnd().endsWith(`… ${String(400 - shown)} more notes not shown`)).toBe(true);
    expect(text).toContain('## Needs rewrite (400)');
  });

  it('under the cap there is no trailer', () => {
    const text = renderSummary({ ...base, note: null, report: sampleReport(), marks: [mark('symbol', 's-total')] });
    expect(text).not.toContain('more notes not shown');
  });
});
