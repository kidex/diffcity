// A modal dialog for the review actions: the "Needs rewrite" note and the
// review summary. Accessible: role="dialog" with aria-modal and a label, focus
// goes in on open and is trapped (Tab and Shift+Tab wrap, focus that escapes
// is brought back), Esc and a click on the backdrop close it, and focus
// returns to what had it. Keys typed in it stay in it, so the screen's
// shortcuts (C G W U J K N R Esc) never act behind it. A dialog opened from
// another one (Send review to agent, from the review summary) stacks on it:
// only the top one holds focus, and closing it gives focus back to its opener
// in the dialog below. Plain DOM.

import { h } from '../../../shared/dom.js';

export interface DialogOptions {
  title: string;
  testId: string;
  /** The content between the title and the buttons. */
  body: HTMLElement[];
  /** The buttons, in order; the dialog adds nothing of its own. */
  actions: HTMLElement[];
  /** The element that gets focus first; the first focusable one by default. */
  initialFocus?: HTMLElement | undefined;
  /** What had focus before: it gets it back on close. */
  returnFocus: Element | null;
  onClose(): void;
}

export interface Dialog {
  root: HTMLElement;
  close(): void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let counter = 0;
/** The open dialogs, the top one last: only it keeps focus. */
const stack: HTMLElement[] = [];

export function openDialog(options: DialogOptions): Dialog {
  counter += 1;
  const titleId = `rv-title-${String(counter)}`;
  const heading = h('h2', { id: titleId, class: 'rv-title' }, options.title);
  const box = h(
    'div',
    { class: 'rv-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'data-testid': options.testId, tabindex: -1 },
    heading,
    h('div', { class: 'rv-body' }, options.body),
    h('div', { class: 'rv-actions' }, options.actions),
  );
  const backdrop = h('div', { class: 'rv-backdrop', 'data-testid': `${options.testId}-backdrop` }, box);
  let closed = false;

  const focusables = (): HTMLElement[] =>
    Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => !element.hidden && element.closest('[hidden]') === null);

  function keepFocus(event: FocusEvent): void {
    if (stack[stack.length - 1] !== box) return;
    if (event.target instanceof Node && !box.contains(event.target)) (focusables()[0] ?? box).focus({ preventScroll: true });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('focusin', keepFocus);
    const at = stack.indexOf(box);
    if (at >= 0) stack.splice(at, 1);
    backdrop.remove();
    const back = options.returnFocus;
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    options.onClose();
  }

  backdrop.addEventListener('keydown', (event) => {
    // Nothing typed here reaches the screen's own shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      box.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });

  document.body.append(backdrop);
  stack.push(box);
  document.addEventListener('focusin', keepFocus);
  (options.initialFocus ?? focusables()[0] ?? box).focus({ preventScroll: true });
  // A first target that cannot take focus (a disabled button) leaves it outside: the dialog's own keys and the screen's shortcuts must not mix.
  if (!box.contains(document.activeElement)) box.focus({ preventScroll: true });
  return { root: box, close };
}
