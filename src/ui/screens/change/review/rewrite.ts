// The note of a "Needs rewrite" mark (ADR-028, amended by DC-135): W marks at
// once, and this dialog, opened from the mark bar's "Add note", adds or edits
// an optional note of at most 2,000 characters and an optional line range,
// prefilled from the line selection of the file view (ADR-027). An empty note
// saves the mark without one; a too long note is blocked here with a message
// and nothing is sent; the daemon checks it again. Plain DOM.

import { h } from '../../../shared/dom.js';
import { NOTE_MAX, noteProblem } from '../model/review.js';
import type { TargetInfo } from '../model/review.js';
import type { MarkRequest } from '../ports.js';
import { openDialog } from './dialog.js';
import type { Dialog } from './dialog.js';

type Lines = NonNullable<MarkRequest['lines']>;

export interface RewriteOptions {
  info: TargetInfo;
  /** The note of the mark being replaced, if any. */
  note: string;
  /** The line range to start from: the file view's selection, else the mark's own. */
  lines: Lines | null;
  returnFocus: Element | null;
  /** `note` is undefined when the field is left empty: the mark has no note. */
  onSave(note: string | undefined, lines: Lines | undefined): void;
  onClose(): void;
}

/** The range typed in the three fields: undefined for none, a message for one that makes no sense. */
export function readLines(side: string, start: string, end: string): { lines: Lines | undefined } | { error: string } {
  if (start.trim() === '' && end.trim() === '') return { lines: undefined };
  if (start.trim() === '' || end.trim() === '') return { error: 'Give the first and the last line, or leave both empty.' };
  const first = Number(start);
  const last = Number(end);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) return { error: 'The lines must be whole numbers, from 1, with the last at or after the first.' };
  return { lines: { side: side === 'old' ? 'old' : 'new', start: first, end: last } };
}

export function openRewriteDialog(options: RewriteOptions): Dialog {
  const { info } = options;
  const note = h('textarea', {
    class: 'rv-input',
    id: 'rv-note',
    rows: 5,
    'aria-describedby': 'rv-note-hint rv-note-error',
    'data-testid': 'rewrite-note',
  });
  note.value = options.note;
  const count = h('span', { id: 'rv-note-hint', class: 'rv-hint', 'data-testid': 'rewrite-note-count' });
  const noteError = h('p', { id: 'rv-note-error', class: 'rv-error', role: 'alert', 'data-testid': 'rewrite-note-error' });
  noteError.hidden = true;
  const side = h('select', { class: 'rv-input rv-side', id: 'rv-side', 'data-testid': 'rewrite-lines-side', 'aria-label': 'Side of the lines' }, h('option', { value: 'new' }, 'new'), h('option', { value: 'old' }, 'old'));
  const start = h('input', { type: 'number', min: 1, step: 1, class: 'rv-input rv-line', 'aria-label': 'First line', 'data-testid': 'rewrite-lines-start' });
  const end = h('input', { type: 'number', min: 1, step: 1, class: 'rv-input rv-line', 'aria-label': 'Last line', 'data-testid': 'rewrite-lines-end' });
  if (options.lines !== null) {
    side.value = options.lines.side;
    start.value = String(options.lines.start);
    end.value = String(options.lines.end);
  }
  const linesError = h('p', { class: 'rv-error', role: 'alert', 'data-testid': 'rewrite-lines-error' });
  linesError.hidden = true;

  const showCount = (): void => {
    count.textContent = `${String(note.value.length)} / ${String(NOTE_MAX)}`;
  };
  showCount();
  note.addEventListener('input', () => {
    showCount();
    if (!noteError.hidden && noteProblem(note.value) === null) {
      noteError.hidden = true;
      note.removeAttribute('aria-invalid');
    }
  });

  let dialog: Dialog | null = null;
  const save = h('button', { type: 'button', class: 'btn primary', 'data-testid': 'rewrite-save' }, 'Save mark');
  const cancel = h('button', { type: 'button', class: 'btn', 'data-testid': 'rewrite-cancel' }, 'Cancel');
  cancel.addEventListener('click', () => dialog?.close());
  save.addEventListener('click', () => {
    const problem = noteProblem(note.value);
    noteError.textContent = problem ?? '';
    noteError.hidden = problem === null;
    if (problem === null) note.removeAttribute('aria-invalid');
    else note.setAttribute('aria-invalid', 'true');
    const range = readLines(side.value, start.value, end.value);
    linesError.textContent = 'error' in range ? range.error : '';
    linesError.hidden = !('error' in range);
    if (problem !== null) {
      note.focus();
      return;
    }
    if ('error' in range) {
      start.focus();
      return;
    }
    const { lines } = range;
    dialog?.close();
    options.onSave(note.value.trim() === '' ? undefined : note.value, lines);
  });

  dialog = openDialog({
    title: info.symbol ? `Needs rewrite: ${info.label}` : 'Needs rewrite: this file',
    testId: 'rewrite-dialog',
    body: [
      h('p', { class: 'rv-lede', 'data-testid': 'rewrite-target' }, info.filePath),
      h('label', { class: 'rv-label', for: 'rv-note' }, 'What needs to be rewritten (optional)'),
      note,
      h('div', { class: 'rv-meta' }, count),
      noteError,
      h('fieldset', { class: 'rv-lines-field' }, h('legend', null, 'Lines (optional)'), side, start, h('span', { 'aria-hidden': 'true' }, 'to'), end),
      linesError,
    ],
    actions: [cancel, save],
    initialFocus: note,
    returnFocus: options.returnFocus,
    onClose: () => {
      options.onClose();
    },
  });
  return dialog;
}
