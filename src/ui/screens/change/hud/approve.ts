// Approve in the top bar (ADR-036), with an ApprovalPort only: the HTML export
// has no button at all. Approve is offered once the daemon's review progress
// says every touched tier 1 file has a current mark; a click asks to confirm
// inline (Confirm approve, Cancel, Esc), then the daemon checks the gate
// again. Approved shows a badge with the short approved head and Undo
// approve. A refusal shows the daemon's reason under the button, which goes
// back to what it was. Text goes in through textContent and attributes only.
// While touched tier 1 files are unmarked, the button is "Check the rest and
// approve" (DC-136): it asks the daemon which files those are, lists them in a
// confirmation (hud/check-rest.ts), and sends that list back; when the daemon
// says the list went stale (`snapshot-moved`, `remaining-changed`) it asks
// again and shows the fresh list. Plain Approve is unchanged.

import type { ReviewProgress } from '../../../../core/model/types.js';
import { h, replaceChildren } from '../../../shared/dom.js';
import type { ApproveView } from '../model/approve.js';
import { APPROVE_FAILED, approveView, CANCEL, CHECK_REST_MOVED, CONFIRM_APPROVE, isStaleList, UNDO_APPROVE } from '../model/approve.js';
import type { ApprovalPort, ApprovalResult, CheckRestResult, FindingAnswer, RemainingFiles } from '../ports.js';
import type { CheckRestDialog } from './check-rest.js';
import { openCheckRestDialog } from './check-rest.js';

export interface ApproveHooks {
  /** "Check the rest and approve" went through: the daemon wrote marks, so the review state is read again. */
  onMarked?(): void;
}

export interface ApproveControl {
  /** The control's element; the top bar puts it among its actions. */
  root: HTMLElement;
  /** The daemon's review progress, or null while there is none: the gate reads its `tier1`. */
  progress(progress: ReviewProgress | null): void;
  /** What the control draws now (for tests and the debug hook). */
  view(): ApproveView;
  dispose(): void;
}

type FocusKey = 'approve' | 'approve-confirm' | 'approve-undo';

export function createApproveControl(port: ApprovalPort, hooks: ApproveHooks = {}): ApproveControl {
  const root = h('span', { class: 'approve', 'data-testid': 'approve-control' });
  let progress: ReviewProgress | null = null;
  let confirming = false;
  let pending: 'approve' | 'undo' | null = null;
  let error: string | null = null;
  let disposed = false;
  /** "Check the rest and approve": the list is being asked for, or its confirmation is open. */
  let asking = false;
  let checking: CheckRestDialog | null = null;
  let bulkPending = false;

  const view = (): ApproveView => approveView({ status: port.status(), progress, confirming, pending, error, checkRest: true });

  /** Asks the daemon for the files to mark and shows them in the confirmation; `notice` says why it is shown again. */
  async function askRemaining(notice: string | null): Promise<void> {
    if (asking) return;
    asking = true;
    error = null;
    // With the confirmation open, focus stays in it.
    render(checking === null ? 'approve' : undefined);
    let result: FindingAnswer<RemainingFiles> | null;
    try {
      result = await port.remaining();
    } catch {
      result = null;
    }
    asking = false;
    if (disposed) return;
    if (result === null || !result.ok) {
      error = result === null ? APPROVE_FAILED : result.refusal.message;
      checking?.close();
      render('approve');
      return;
    }
    if (checking !== null) {
      checking.show(result.value, notice);
      return;
    }
    // Opened only on the reviewer's click, never again behind their back once closed.
    if (notice !== null) return;
    checking = openCheckRestDialog(result.value, {
      onConfirm: (shown) => void confirmRest(shown),
      onClose: () => {
        checking = null;
        render('approve');
      },
    });
    render();
  }

  async function confirmRest(shown: RemainingFiles): Promise<void> {
    if (bulkPending) return;
    bulkPending = true;
    checking?.busy(true);
    let result: FindingAnswer<CheckRestResult> | null;
    try {
      result = await port.checkRest(shown);
    } catch {
      result = null;
    }
    bulkPending = false;
    if (disposed) return;
    checking?.busy(false);
    if (result?.ok === true) {
      hooks.onMarked?.();
      const open = checking;
      checking = null;
      open?.close();
      render('approve-undo');
      return;
    }
    if (result !== null && isStaleList(result.refusal.code) && checking !== null) {
      await askRemaining(CHECK_REST_MOVED);
      return;
    }
    error = result === null ? APPROVE_FAILED : result.refusal.message;
    const open = checking;
    checking = null;
    open?.close();
    render('approve');
  }

  function button(testId: FocusKey | 'approve-cancel', label: string, primary: boolean, title: string | null, inert: boolean, onClick: () => void): HTMLButtonElement {
    const node = h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', 'data-testid': testId, title }, label);
    if (inert) node.setAttribute('aria-disabled', 'true');
    node.addEventListener('click', (event) => {
      event.preventDefault();
      if (node.getAttribute('aria-disabled') === 'true') return;
      onClick();
    });
    return node;
  }

  const errorLine = (text: string | null): HTMLElement | null =>
    text === null ? null : h('span', { class: 'approve-error', role: 'alert', 'data-testid': 'approve-error' }, text);

  async function send(action: 'approve' | 'undo'): Promise<void> {
    pending = action;
    error = null;
    render(action === 'approve' ? 'approve-confirm' : 'approve-undo');
    let result: FindingAnswer<ApprovalResult> | null = null;
    try {
      result = action === 'approve' ? await port.approve() : await port.unapprove();
      if (!result.ok) error = result.refusal.message;
    } catch {
      error = APPROVE_FAILED;
    }
    if (disposed) return;
    pending = null;
    confirming = false;
    const approved = result?.ok === true ? action === 'approve' : action === 'undo';
    render(approved ? 'approve-undo' : 'approve');
  }

  function cancel(): void {
    confirming = false;
    render('approve');
  }

  function render(focus?: FocusKey): void {
    if (disposed) return;
    const had = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset['testid'] : undefined;
    const shown = view();
    root.hidden = shown.kind === 'hidden';
    root.dataset['state'] = shown.kind === 'gate' ? (shown.open ? 'open' : 'closed') : shown.kind;
    delete root.dataset['bulk'];
    switch (shown.kind) {
      case 'hidden':
        replaceChildren(root);
        break;
      case 'gate':
        root.dataset['bulk'] = String(shown.bulk);
        replaceChildren(
          root,
          button('approve', asking && shown.bulk ? 'Listing the files…' : shown.label, true, shown.title, !shown.open || asking || checking !== null, () => {
            if (shown.bulk) {
              void askRemaining(null);
              return;
            }
            confirming = true;
            error = null;
            render('approve-confirm');
          }),
          errorLine(shown.error),
        );
        break;
      case 'confirm': {
        const group = h(
          'span',
          { class: 'approve-confirm', role: 'group', 'aria-label': 'Confirm approve', 'data-testid': 'approve-confirm-group' },
          h('span', { class: 'approve-prompt', title: shown.title }, shown.prompt),
          button('approve-confirm', shown.pending ? 'Approving…' : CONFIRM_APPROVE, true, shown.title, shown.pending, () => void send('approve')),
          shown.pending ? null : button('approve-cancel', CANCEL, false, null, false, cancel),
        );
        group.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape' || pending !== null) return;
          event.stopPropagation();
          cancel();
        });
        replaceChildren(root, group);
        break;
      }
      case 'approved':
        replaceChildren(
          root,
          h(
            'span',
            { class: 'approved-badge', 'data-testid': 'approved-badge', title: shown.title },
            h('i', { 'aria-hidden': 'true' }),
            'Approved ',
            h('code', { 'data-testid': 'approved-head' }, shown.head),
          ),
          button('approve-undo', shown.pending ? 'Undoing…' : UNDO_APPROVE, false, null, shown.pending, () => void send('undo')),
          errorLine(shown.error),
        );
        break;
    }
    const target = focus ?? had;
    if (target === undefined || (focus === undefined && had === undefined)) return;
    const node = root.querySelector<HTMLElement>(`[data-testid="${target}"]`) ?? root.querySelector<HTMLElement>('button');
    node?.focus({ preventScroll: true });
  }

  const stop = port.onChange(() => {
    render();
  });
  render();

  return {
    root,
    progress(next) {
      progress = next;
      render();
    },
    view,
    dispose() {
      disposed = true;
      checking?.close();
      stop();
      root.remove();
    },
  };
}
