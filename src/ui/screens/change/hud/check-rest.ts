// The confirmation of "Check the rest and approve" (ADR-028 amendment, DC-135,
// DC-136): one modal dialog that lists the touched tier 1 files the daemon
// says have no current mark, what confirming does, and Cancel. It decides
// nothing: the list and the outcome are the daemon's; when the daemon says the
// list went stale, the control asks it again and shows the fresh list here
// with a notice. Paths go in through textContent.

import { h, replaceChildren } from '../../../shared/dom.js';
import { checkRestView } from '../model/approve.js';
import type { RemainingFiles } from '../ports.js';
import type { Dialog } from '../review/dialog.js';
import { openDialog } from '../review/dialog.js';

export interface CheckRestDialogOptions {
  onConfirm(shown: RemainingFiles): void;
  /** Esc, Cancel, the backdrop, or close() once the daemon answered. */
  onClose(): void;
}

export interface CheckRestDialog {
  /** Shows `shown` as the list to confirm; `notice` says why it is shown again. */
  show(shown: RemainingFiles, notice: string | null): void;
  /** A request is in flight: Confirm waits. */
  busy(on: boolean): void;
  close(): void;
}

export function openCheckRestDialog(first: RemainingFiles, options: CheckRestDialogOptions): CheckRestDialog {
  const notice = h('p', { class: 'rv-error', role: 'alert', 'data-testid': 'check-rest-notice' });
  notice.hidden = true;
  const lede = h('p', { class: 'rv-hint', 'data-testid': 'check-rest-lede' });
  const list = h('ul', { class: 'check-rest-files', 'aria-label': 'Files to mark Checked', 'data-testid': 'check-rest-files' });
  const confirm = h('button', { type: 'button', class: 'btn primary', 'data-testid': 'check-rest-confirm' });
  const cancel = h('button', { type: 'button', class: 'btn', 'data-testid': 'check-rest-cancel' }, 'Cancel');
  let shown = first;
  let pending = false;
  let label = '';

  function show(next: RemainingFiles, why: string | null): void {
    shown = next;
    const view = checkRestView(next);
    lede.textContent = view.lede;
    replaceChildren(
      list,
      view.files.map((path) => h('li', { 'data-testid': 'check-rest-file' }, h('code', null, path))),
    );
    list.hidden = view.files.length === 0;
    notice.textContent = why ?? '';
    notice.hidden = why === null;
    label = view.confirm;
    if (!pending) confirm.textContent = label;
  }

  function busy(on: boolean): void {
    pending = on;
    confirm.textContent = on ? 'Approving…' : label;
    if (on) confirm.setAttribute('aria-disabled', 'true');
    else confirm.removeAttribute('aria-disabled');
  }

  confirm.addEventListener('click', () => {
    if (pending) return;
    options.onConfirm(shown);
  });
  cancel.addEventListener('click', () => {
    dialog.close();
  });

  show(first, null);
  const dialog: Dialog = openDialog({
    title: checkRestView(first).title,
    testId: 'check-rest-dialog',
    body: [notice, lede, list],
    actions: [cancel, confirm],
    initialFocus: confirm,
    // The control draws its buttons again when the dialog goes and puts focus back itself.
    returnFocus: null,
    onClose: () => {
      options.onClose();
    },
  });
  return { show, busy, close: () => { dialog.close(); } };
}
