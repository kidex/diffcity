// The "Send review to agent" dialog (ADR-029), opened from the review summary.
// It shows what the daemon previewed, exactly: the argv one item per line, the
// working tree, the session it resumes (title and time range) or why it starts
// a new one, the permission note, and the full summary that goes on stdin.
// "Send to agent" is offered only when the daemon refused nothing, and is
// enabled (and focused) only once the end of the summary has been in view.
// Any refusal is listed and Send is not there at all. Copy and "Add to fix
// queue" are always there. Every string goes in through textContent.

import { h, replaceChildren } from '../../../shared/dom.js';
import type { SendDialogView } from '../model/agent.js';
import {
  ADD_TO_QUEUE,
  PREVIEW_FAILED,
  queuedText,
  REFUSED,
  RUN_FAILED,
  SCROLL_TO_SEND,
  SEND,
  SEND_TITLE,
  sendDialogView,
  sendEnabled,
  SENDING,
} from '../model/agent.js';
import type { AgentPort, AgentPreview, FindingRefusal } from '../ports.js';
import type { Dialog } from './dialog.js';
import { openDialog } from './dialog.js';
import { copyText } from './summary.js';

export interface SendDialogOptions {
  port: AgentPort;
  returnFocus: Element | null;
  /** The daemon accepted the run (202). */
  onSent(runId: string): void;
  onClose(): void;
}

const field = (label: string, ...value: (HTMLElement | null)[]): HTMLElement =>
  h('div', { class: 'ag-field' }, h('span', { class: 'rv-label' }, label), ...value);

export function openSendDialog(options: SendDialogOptions): Dialog {
  const { port } = options;
  const details = h('div', { class: 'ag-details', 'data-testid': 'send-details' });
  const refusals = h('div', { class: 'ag-refusals', role: 'alert', 'data-testid': 'send-refusals' });
  refusals.hidden = true;
  const text = h('pre', { class: 'rv-summary ag-summary', tabindex: 0, 'aria-label': 'Review summary, sent on stdin', 'data-testid': 'send-summary' });
  // The last line of the summary: Send waits until it has been in view.
  const end = h('span', { class: 'ag-end', 'aria-hidden': 'true', 'data-testid': 'send-summary-end' });
  const hint = h('p', { class: 'rv-hint', 'data-testid': 'send-hint' }, SCROLL_TO_SEND);
  const status = h('span', { class: 'rv-hint', role: 'status', 'data-testid': 'send-status' });
  const copy = h('button', { type: 'button', class: 'btn', 'data-testid': 'send-copy' }, 'Copy');
  const queue = h('button', { type: 'button', class: 'btn', 'data-testid': 'send-queue' }, ADD_TO_QUEUE);
  const send = h('button', { type: 'button', class: 'btn primary', 'data-testid': 'send-run' }, SEND);
  const cancel = h('button', { type: 'button', class: 'btn', 'data-testid': 'send-cancel' }, 'Cancel');
  let preview: AgentPreview | null = null;
  let view: SendDialogView | null = null;
  let read = false;
  let pending = false;
  /** The token went to the daemon and was refused or lost: Send needs a new preview. */
  let spent = false;
  let closed = false;
  let observer: IntersectionObserver | null = null;

  function showRefusals(list: FindingRefusal[]): void {
    refusals.hidden = list.length === 0;
    replaceChildren(
      refusals,
      list.length === 0
        ? null
        : [
            h('p', { class: 'ag-refusals-lede' }, REFUSED),
            h(
              'ul',
              null,
              list.map((refusal) => h('li', { 'data-testid': 'send-refusal', 'data-code': refusal.code }, refusal.message)),
            ),
          ],
    );
  }

  function sync(): void {
    const offered = view !== null && view.sendable && !spent;
    send.hidden = !offered;
    const enabled = offered && view !== null && sendEnabled(view, read, pending);
    send.disabled = !enabled;
    send.textContent = pending ? SENDING : SEND;
    hint.hidden = !offered || read;
    copy.disabled = preview === null;
    queue.disabled = preview === null || pending;
  }

  function fill(next: AgentPreview): void {
    preview = next;
    view = sendDialogView(next);
    const shown = view;
    const argv = h(
      'ol',
      { class: 'ag-argv', 'aria-label': 'Command, one argument per line', 'data-testid': 'send-argv' },
      shown.argv.map((arg) => h('li', null, h('code', null, arg))),
    );
    const session =
      shown.session === null
        ? null
        : shown.session.kind === 'resume'
          ? h(
              'p',
              { class: 'ag-session', 'data-testid': 'send-session', 'data-mode': 'resume' },
              'Resumes ',
              h('b', { 'data-testid': 'send-session-title' }, shown.session.title),
              shown.session.range === null ? null : h('span', { class: 'ag-range', 'data-testid': 'send-session-range' }, shown.session.range),
            )
          : h('p', { class: 'ag-session', 'data-testid': 'send-session', 'data-mode': 'new' }, `New session: ${shown.session.reason}`);
    replaceChildren(
      details,
      shown.argv.length === 0 ? null : field('Command', argv),
      shown.cwd === null ? null : field('Working tree', h('code', { class: 'ag-cwd', 'data-testid': 'send-cwd' }, shown.cwd)),
      session === null ? null : field('Session', session),
      h('p', { class: 'ag-permission', 'data-testid': 'send-permission' }, shown.permission),
      shown.timeout === null ? null : h('p', { class: 'rv-hint', 'data-testid': 'send-timeout' }, shown.timeout),
    );
    showRefusals(shown.refusals);
    text.replaceChildren(document.createTextNode(shown.summary), end);
    read = false;
    spent = false;
    observe();
    sync();
  }

  function observe(): void {
    observer?.disconnect();
    if (typeof IntersectionObserver === 'undefined') {
      // Without an observer there is no way to know the summary was read: Send stays off; Copy and the fix queue remain.
      return;
    }
    observer = new IntersectionObserver((entries) => {
      if (closed || read || !entries.some((entry) => entry.isIntersecting)) return;
      read = true;
      observer?.disconnect();
      sync();
      if (!send.hidden && !send.disabled) send.focus({ preventScroll: true });
    });
    observer.observe(end);
  }

  function load(): void {
    details.replaceChildren(h('p', { class: 'rv-hint', role: 'status', 'data-testid': 'send-loading' }, 'Asking the daemon what would run…'));
    text.textContent = '';
    preview = null;
    view = null;
    showRefusals([]);
    sync();
    port.preview().then(
      (answer) => {
        if (closed) return;
        if (answer.ok) {
          fill(answer.value);
          return;
        }
        details.replaceChildren();
        showRefusals([answer.refusal]);
        sync();
      },
      () => {
        if (closed) return;
        details.replaceChildren();
        showRefusals([{ code: 'no-answer', message: PREVIEW_FAILED }]);
        sync();
      },
    );
  }

  send.addEventListener('click', () => {
    if (preview === null || view === null || !sendEnabled(view, read, pending) || spent || preview.token === null) return;
    pending = true;
    status.textContent = '';
    sync();
    port.run(preview.token, preview.summaryHash).then(
      (answer) => {
        if (closed) return;
        pending = false;
        spent = true;
        if (answer.ok) {
          sync();
          options.onSent(answer.value.runId);
          dialog.close();
          return;
        }
        showRefusals([answer.refusal]);
        sync();
        cancel.focus({ preventScroll: true });
      },
      () => {
        if (closed) return;
        pending = false;
        spent = true;
        showRefusals([{ code: 'no-answer', message: RUN_FAILED }]);
        sync();
        cancel.focus({ preventScroll: true });
      },
    );
  });
  copy.addEventListener('click', () => {
    if (preview === null) return;
    status.textContent = '';
    void copyText(preview.summary).then((copied) => {
      if (!closed) status.textContent = copied ? 'Copied' : 'Could not copy: select the text and copy it by hand';
    });
  });
  queue.addEventListener('click', () => {
    if (preview === null) return;
    status.textContent = 'Adding to the fix queue…';
    queue.disabled = true;
    port.queue(preview.summaryHash).then(
      (answer) => {
        if (closed) return;
        status.textContent = answer.ok ? queuedText(answer.value) : `Not added: ${answer.refusal.message}`;
        sync();
      },
      () => {
        if (closed) return;
        status.textContent = 'Not added: the daemon did not answer';
        sync();
      },
    );
  });

  cancel.addEventListener('click', () => {
    dialog.close();
  });
  const dialog: Dialog = openDialog({
    title: SEND_TITLE,
    testId: 'send-dialog',
    body: [
      h('p', { class: 'rv-lede' }, 'diffcity runs this command in the change’s working tree, with the summary below on stdin. Nothing runs until you send it.'),
      details,
      refusals,
      h('span', { class: 'rv-label' }, 'Summary'),
      text,
      hint,
    ],
    actions: [status, copy, queue, send, cancel],
    initialFocus: text,
    returnFocus: options.returnFocus,
    onClose: () => {
      closed = true;
      observer?.disconnect();
      options.onClose();
    },
  });
  load();
  return dialog;
}
