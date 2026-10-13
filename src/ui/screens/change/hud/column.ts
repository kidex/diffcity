// The HUD's left column (DC-139): the title and the filter rows at the top, the
// legend at the bottom, stacked so they never overlap. When the city is too
// short for the whole legend under every filter row, the title's sentence goes
// first; if that is not enough, the legend folds into a
// "Legend" chip that opens it as a popover (Esc or a click elsewhere closes it,
// focus goes back to the chip). When the city is too short even for the filter
// rows, they scroll inside the column, so every chip stays reachable; a drag
// or a wheel on the scroll box beside the chips still reaches the city.

import { h } from '../../../shared/dom.js';

export interface LeftColumn {
  root: HTMLElement;
  /** Measures again: after the filter rows or the legend changed. */
  fit(): void;
  dispose(): void;
}

let ids = 0;

export function createLeftColumn(title: HTMLElement, filters: HTMLElement, legend: HTMLElement): LeftColumn {
  ids += 1;
  const legendId = `hud-legend-${String(ids)}`;
  legend.id = legendId;
  const toggle = h(
    'button',
    { type: 'button', class: 'chip legend-toggle', 'aria-expanded': 'false', 'aria-controls': legendId, 'data-testid': 'legend-toggle' },
    'Legend',
  );
  const slot = h('div', { class: 'legend-slot' }, toggle, legend);
  const root = h('div', { class: 'hud-left', 'data-testid': 'hud-left' }, h('div', { class: 'hud-head' }, title, filters), slot);
  let open = false;

  const overflows = (): boolean => filters.scrollHeight > filters.clientHeight + 1;

  function close(returnFocus: boolean): void {
    if (!open) return;
    open = false;
    root.classList.remove('legend-open');
    toggle.setAttribute('aria-expanded', 'false');
    legend.setAttribute('role', 'group');
    legend.removeAttribute('tabindex');
    document.removeEventListener('pointerdown', outside, true);
    if (returnFocus) toggle.focus({ preventScroll: true });
  }

  function show(): void {
    if (open) return;
    open = true;
    root.classList.add('legend-open');
    toggle.setAttribute('aria-expanded', 'true');
    legend.setAttribute('role', 'dialog');
    legend.tabIndex = -1;
    document.addEventListener('pointerdown', outside, true);
    legend.focus({ preventScroll: true });
  }

  function outside(event: PointerEvent): void {
    if (event.target instanceof Node && slot.contains(event.target)) return;
    close(false);
  }

  function fit(): void {
    // Focus on the chip or in the popover has nowhere to stay if the legend unfolds.
    const focused = document.activeElement instanceof Node && slot.contains(document.activeElement);
    // Start from everything shown, then give way one step at a time while the
    // filter rows run out of room: the title's sentence, then the legend
    // (folded into its chip), and last the rows scroll.
    root.classList.remove('terse', 'legend-folded');
    filters.classList.remove('scrolls');
    if (overflows()) root.classList.add('terse');
    const folded = overflows();
    root.classList.toggle('legend-folded', folded);
    filters.classList.toggle('scrolls', folded && overflows());
    if (folded) return;
    close(false);
    if (focused) filters.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  toggle.addEventListener('click', () => {
    if (open) close(true);
    else show();
  });
  slot.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    // The city's own Escape (clear the selection) waits for the next press.
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });

  // Tabbing out of the popover closes it, so it never stays over the filters unattended.
  slot.addEventListener('focusout', (event) => {
    if (!open) return;
    if (event.relatedTarget instanceof Node && slot.contains(event.relatedTarget)) return;
    close(false);
  });

  // The scroll box takes the pointer for its scrollbar; a press, a move or a
  // wheel on it beside the chips goes on to the city's canvas, as it would
  // through the HUD anywhere else.
  const canvas = (): HTMLElement | null => root.closest('.city')?.querySelector<HTMLElement>('canvas.scene') ?? null;
  const besideChips = (event: MouseEvent): boolean =>
    filters.classList.contains('scrolls') &&
    event.target instanceof Element &&
    event.target.closest('button') === null &&
    // Not on the scrollbar, which sits right of the client area.
    event.clientX < filters.getBoundingClientRect().left + filters.clientLeft + filters.clientWidth;
  const forward = (event: PointerEvent | WheelEvent): void => {
    const target = canvas();
    if (target === null || !besideChips(event)) return;
    event.preventDefault();
    target.dispatchEvent(event instanceof WheelEvent ? new WheelEvent(event.type, event) : new PointerEvent(event.type, event));
  };
  filters.addEventListener('pointerdown', forward);
  filters.addEventListener('pointermove', forward);
  filters.addEventListener('wheel', forward, { passive: false });

  const observer = new ResizeObserver(() => {
    fit();
  });
  observer.observe(root);
  void document.fonts.ready.then(() => {
    if (root.isConnected) fit();
  });

  return {
    root,
    fit,
    dispose() {
      observer.disconnect();
      close(false);
    },
  };
}
