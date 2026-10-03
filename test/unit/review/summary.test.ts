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
        '> Mostly fine, two things to redo.',
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
  const hostile = 'first line\n## Injected\n# Title\n   # indented heading\r\n### Third';

  it('a note with "\\n## Injected" and "\\n# Title" stays under its bullet', () => {
    const text = renderSummary({
      ...base,
      note: 'general\n## Injected general\n# Title general',
      report: sampleReport(),
      marks: [mark('symbol', 's-total', { note: hostile }), mark('file', 'f-tax', { note: hostile })],
    });
    // Only the structure the renderer wrote, plus the quoted general note.
    expect(headingLines(text).filter((line) => !line.startsWith('>'))).toEqual([
      TITLE,
      '## Needs rewrite (2)',
      '### src/cart/total.ts',
      '### src/cart/tax.ts',
    ]);
    const lines = text.split('\n');
    const start = lines.indexOf('- `total`: first line');
    expect(lines.slice(start, start + 5)).toEqual([
      '- `total`: first line',
      '  \\## Injected',
      '  \\# Title',
      '     \\# indented heading',
      '  \\### Third',
    ]);
    expect(lines).toContain('> \\## Injected general');
    expect(lines).toContain('> \\# Title general');
  });

  // Every line a note contributes is either on a bullet line, indented under it,
  // or in the general note's blockquote; nothing of a note sits at column 0
  // unquoted, so no markdown construct can reach the structure after it.
  const NASTY = ['```', '~~~ js', '<!--', '<div>', '---', '===', '> x', '- x', '* x', '+ x', '1. x', '| a | b |', '___', '    code', '[ref]: http://example.test'];

  it.each(NASTY)('a note line "%s" in the general note and in a bullet note leaves the structure intact', (nasty) => {
    const note = `before\n${nasty}\nafter`;
    const text = renderSummary({
      ...base,
      note,
      report: sampleReport(),
      marks: [mark('symbol', 's-total', { note }), mark('symbol', 's-round', { note: `second\n${nasty}` }), mark('file', 'f-tax', { note })],
    });
    const lines = text.split('\n');
    const structural = (line: string): boolean =>
      line === '' || line === TITLE || line === '## Needs rewrite (3)' || line.startsWith('### src/cart/') || line.startsWith('- ');
    for (const line of lines) {
      // Unindented, unquoted lines are structure only.
      if (!line.startsWith('> ') && !line.startsWith('  ')) expect(structural(line), `line ${JSON.stringify(line)}`).toBe(true);
    }
    // The section heading appears once, after the whole general note, and the bullets are all there.
    expect(lines.filter((line) => line === '## Needs rewrite (3)')).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('- '))).toEqual(['- `total`: before', '- `roundCents`: second', '- Whole file: before']);
    const general = lines.filter((line) => line.startsWith('> '));
    expect(general).toHaveLength(3);
    expect(lines.indexOf('## Needs rewrite (3)')).toBeGreaterThan(lines.lastIndexOf(general[2] ?? ''));
    // A block-starting character of the note is escaped, so it is text.
    const quoted = general[1] ?? '';
    expect(quoted).not.toMatch(/^> (```|~~~|<|---|===|>|-|\*|\+|\d+\.|\||___)/);
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

  it('a single hidden note is "1 more note", in the singular', () => {
    const files = Array.from({ length: 20 }, (_, f) =>
      file(`g${String(f)}`, `src/gen/g-${String(f)}.ts`, 'mod', 'ok', Array.from({ length: 10 }, (_, s) => sym(`g${String(f)}s${String(s)}`, `fn${String(s)}`))),
    );
    const report: Report = { ...sampleReport(), packages: [{ id: 'p', path: 'src/gen', tier1: false, files }] };
    const all = files.flatMap((f) => f.symbols.map((s) => s.id));
    // Find the count at which exactly one note is cut.
    for (let n = 1; n <= all.length; n += 1) {
      const marks = all.slice(0, n).map((id) => mark('symbol', id, { note: 'n'.repeat(1900) }));
      const text = renderSummary({ ...base, note: null, report, marks });
      if (text.endsWith('\n… 1 more note not shown\n')) {
        expect(text).not.toContain('1 more notes');
        return;
      }
    }
    throw new Error('no count hid exactly one note');
  });

  it('under the cap there is no trailer', () => {
    const text = renderSummary({ ...base, note: null, report: sampleReport(), marks: [mark('symbol', 's-total')] });
    expect(text).not.toContain('more notes not shown');
  });
});
