// The markdown summary of the "Needs rewrite" marks (ADR-028), pure.
//
//   # Review of <ref> in <repo name> (head <7-char sha>)
//   <general note>
//   ## Needs rewrite (<n>)
//   ### <file path>
//   - `<symbol name>`, lines <start>–<end>: <note>
//   - Whole file: <note>
//
// Notes are inserted as text. Every line after the first of a bullet note is
// indented under its bullet; the general note is a blockquote, one `> ` per
// line. In both, a character that would start a block is backslash-escaped, so
// a note cannot open a heading, fence, comment, list or setext underline. The result is at most SUMMARY_MAX_BYTES; past that it ends with
// "… N more notes not shown".

import type { ReviewMark } from '../model/types.js';
import type { Report } from '../report/types.js';

export const SUMMARY_MAX_BYTES = 32 * 1024;

export interface SummaryInput {
  /** The change's ref as shown to the reader (branch name, `pr:12`, ...). */
  ref: string;
  repoName: string;
  /** The head commit sha; shortened to 7 characters. */
  head: string;
  /** The general note; null or empty for none. */
  note: string | null;
  report: Report;
  marks: readonly ReviewMark[];
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** One line of free text: control characters (line breaks included) become spaces. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return text.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').trim();
}

/**
 * Neutralises a line that would start a block: a backslash before a leading
 * heading, quote, list, rule, setext underline, fence, HTML or table character,
 * and before the dot of a leading `1.`. The text stays readable and is still
 * text, whatever it holds.
 */
function escapeLine(line: string): string {
  return line
    .replace(/^(\s*)([#>+*=~`<|_-])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/, '$1\\$2');
}

function rawLines(note: string): string[] {
  return note.replace(/\r\n?/g, '\n').split('\n');
}

/** The note as the tail of a bullet: the first line follows the label, the others are indented. */
function bulletText(label: string, note: string): string {
  const [first = '', ...rest] = rawLines(note);
  return [`- ${label}: ${first}`, ...rest.map((line) => `  ${escapeLine(line)}`)].join('\n') + '\n';
}

interface Entry {
  filePath: string;
  text: string;
}

function entriesOf(input: SummaryInput): Entry[] {
  const current = new Map<string, ReviewMark>();
  for (const mark of input.marks) {
    if (mark.state === 'current' && mark.mark === 'rewrite' && mark.note !== null) {
      current.set(`${mark.targetKind}:${mark.targetId}`, mark);
    }
  }
  const range = (mark: ReviewMark): string => (mark.lines === null ? '' : `lines ${String(mark.lines.start)}–${String(mark.lines.end)}`);
  const entries: Entry[] = [];
  for (const pkg of input.report.packages) {
    for (const file of pkg.files) {
      const filePath = oneLine(file.path);
      for (const symbol of file.symbols) {
        const mark = current.get(`symbol:${symbol.id}`);
        if (mark?.note == null) continue;
        const name = `\`${oneLine(symbol.name).replaceAll('`', "'")}\``;
        entries.push({ filePath, text: bulletText(range(mark) === '' ? name : `${name}, ${range(mark)}`, mark.note) });
      }
      const fileMark = current.get(`file:${file.id}`);
      if (fileMark?.note != null) {
        const label = range(fileMark) === '' ? 'Whole file' : `Whole file, ${range(fileMark)}`;
        entries.push({ filePath, text: bulletText(label, fileMark.note) });
      }
    }
  }
  return entries;
}

export function renderSummary(input: SummaryInput): string {
  const entries = entriesOf(input);
  let out = `# Review of ${oneLine(input.ref)} in ${oneLine(input.repoName)} (head ${oneLine(input.head).slice(0, 7)})\n\n`;
  const general = input.note?.trim() ?? '';
  // A blockquote closes with the note: an unclosed fence or comment cannot reach the sections below.
  if (general !== '') out += `${rawLines(general).map((line) => `> ${escapeLine(line)}`).join('\n')}\n\n`;
  out += `## Needs rewrite (${String(entries.length)})\n`;

  // The trailer is reserved up front, so it always fits.
  const trailer = (hidden: number): string => `\n… ${String(hidden)} more ${hidden === 1 ? 'note' : 'notes'} not shown\n`;
  const reserve = bytes(trailer(entries.length));
  let lastFile: string | null = null;
  for (const [index, entry] of entries.entries()) {
    const heading = entry.filePath === lastFile ? '' : `\n### ${entry.filePath}\n`;
    const piece = heading + entry.text;
    if (bytes(out) + bytes(piece) + reserve > SUMMARY_MAX_BYTES) return out + trailer(entries.length - index);
    out += piece;
    lastFile = entry.filePath;
  }
  return out;
}
