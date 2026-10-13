// The HUD's left column (DC-139): the title and the filter rows at the top, the
// legend at the bottom, stacked so they never overlap. When the city is too
// short for the whole legend under every filter row, the title's sentence goes
// first; if that is not enough, the legend folds into a
// "Legend" chip that opens it as a popover (Esc or a click elsewhere closes it,
// focus goes back to the chip). When the city is too short even for the filter
// rows, they scroll inside the column, so every chip stays reachable.

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
    // Start from everything shown, then give way one step at a time while the
    // filter rows run out of room: the title's sentence, then the legend
    // (folded into its chip), and last the rows scroll.
    root.classList.remove('terse', 'legend-folded');
    filters.classList.remove('scrolls');
    if (overflows()) root.classList.add('terse');
    const folded = overflows();
    root.classList.toggle('legend-folded', folded);
    if (!folded) close(false);
    filters.classList.toggle('scrolls', folded && overflows());
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
