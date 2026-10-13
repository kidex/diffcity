// The review summary dialog (ADR-028, SPEC.md section 6): the markdown the
// daemon wrote from the "Needs rewrite" marks and the general note, shown as
// plain text (never rendered to HTML: the notes are the reviewer's words and
// the paths the repo's), a field for the general note, Copy to clipboard, and,
// with an AgentPort, "Send review to agent" (ADR-029), which opens its own
// dialog over this one. Plain DOM.

import { h } from '../../../shared/dom.js';
import type { ReviewController } from './controller.js';
import { openDialog } from './dialog.js';
import type { Dialog } from './dialog.js';

export const SEND_REVIEW = 'Send review to agent';
export const NO_SUMMARY = 'This change has no snapshot yet, so there is no summary.';
export const SUMMARY_FAILED = 'The summary could not be loaded.';

/** Copies `text`: the Clipboard API where the page may use it, else a hidden field and execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = h('textarea', { 'aria-hidden': 'true', tabindex: -1, readonly: true, style: 'position:fixed;left:-9999px;top:0' });
    field.value = text;
    document.body.append(field);
    field.select();
    try {
      // The only way to copy where the Clipboard API is not available (a page that is not a secure context).
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}

export interface SummaryDialog {
  dialog: Dialog;
  /** The marks or the note moved: read the summary again. */
  refresh(): void;
}

/** `onSend`: with an AgentPort, opens the send dialog from the button it is given; without one there is no such button. */
export function openSummaryDialog(controller: ReviewController, returnFocus: Element | null, onClose: () => void, onSend?: (trigger: HTMLElement) => void): SummaryDialog {
  const text = h('pre', { class: 'rv-summary', tabindex: 0, 'aria-label': 'Review summary, as markdown', 'data-testid': 'summary-text' });
  const note = h('textarea', { class: 'rv-input', id: 'rv-general', rows: 3, 'data-testid': 'summary-note' });
  note.value = controller.state()?.note ?? '';
  /** The note as last saved or loaded: the field follows a note saved elsewhere (the send dialog) unless it holds the reviewer's own edit. */
  let shownNote = note.value;
  const noteStatus = h('p', { class: 'rv-hint', role: 'status', 'data-testid': 'summary-note-status' });
  const copyStatus = h('span', { class: 'rv-hint', role: 'status', 'data-testid': 'summary-copy-status' });
  const saveNote = h('button', { type: 'button', class: 'btn', 'data-testid': 'summary-note-save' }, 'Save note');
  const copy = h('button', { type: 'button', class: 'btn primary', 'data-testid': 'summary-copy' }, 'Copy to clipboard');
  const close = h('button', { type: 'button', class: 'btn', 'data-testid': 'summary-close' }, 'Close');
  const send =
    onSend === undefined ? null : h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', 'data-testid': 'summary-send' }, SEND_REVIEW);
  send?.addEventListener('click', () => {
    onSend?.(send);
  });
  let markdown: string | null = null;
  let request: AbortController | null = null;
  let closed = false;

  function load(): void {
    request?.abort();
    const current = new AbortController();
    request = current;
    controller.summary(current.signal).then(
      (answer) => {
        if (current.signal.aborted || closed) return;
        markdown = answer;
        text.textContent = answer ?? NO_SUMMARY;
        copy.disabled = answer === null;
      },
      () => {
        if (current.signal.aborted || closed) return;
        markdown = null;
        text.textContent = SUMMARY_FAILED;
        copy.disabled = true;
      },
    );
  }

  text.textContent = 'Loading the summary…';
  copy.disabled = true;
  copy.addEventListener('click', () => {
    if (markdown === null) return;
    copyStatus.textContent = '';
    void copyText(markdown).then((copied) => {
      copyStatus.textContent = copied ? 'Copied' : 'Could not copy: select the text and copy it by hand';
    });
  });
  saveNote.addEventListener('click', () => {
    noteStatus.textContent = 'Saving…';
    void controller.saveNote(note.value).then((saved) => {
      noteStatus.textContent = saved ? 'Note saved' : 'The note was not saved';
      if (saved) {
        shownNote = note.value;
        load();
      }
    });
  });

  let dialog: Dialog | null = null;
  close.addEventListener('click', () => dialog?.close());
  dialog = openDialog({
    title: 'Review summary',
    testId: 'summary-dialog',
    body: [
      h('p', { class: 'rv-lede' }, 'The notes of every "Needs rewrite" mark, as markdown, with your general note.'),
      text,
      h('label', { class: 'rv-label', for: 'rv-general' }, 'General note'),
      note,
      h('div', { class: 'rv-meta' }, saveNote, noteStatus),
    ],
    actions: [copyStatus, copy, send, close].filter((node): node is HTMLElement => node !== null),
    initialFocus: copy,
    returnFocus,
    onClose: () => {
      closed = true;
      request?.abort();
      onClose();
    },
  });
  load();
  return {
    dialog,
    refresh() {
      const latest = controller.state()?.note ?? '';
      if (note.value === shownNote && latest !== shownNote) {
        note.value = latest;
        shownNote = latest;
      }
      load();
    },
  };
}
