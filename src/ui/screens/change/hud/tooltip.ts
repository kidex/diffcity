// The hover tooltip (mockup .tip): verdict, file, package, counts by status,
// the floor under the cursor, the number of findings, and the rule violations
// when there are any. Text goes in through textContent: file names and
// finding counts come from the repo under review.

import { h, replaceChildren } from '../../../shared/dom.js';
import { VERDICT_LABEL } from '../../../shared/format.js';
import { verdictToken } from '../../../shared/tokens.js';
import type { TipData } from '../model/hud.js';
import { countLine } from '../model/hud.js';

export interface Tooltip {
  root: HTMLElement;
  /** Shows the tip for `data` next to a point given in the coordinates of `container`. */
  show(data: TipData, x: number, y: number): void;
  hide(): void;
}

export function createTooltip(container: HTMLElement): Tooltip {
  const root = h('div', { class: 'tip', role: 'tooltip', 'data-testid': 'tooltip' });
  return {
    root,
    show(data, x, y) {
      const verdict = h('div', { class: 'v', 'data-testid': 'tip-verdict' }, h('i', { 'aria-hidden': 'true' }), VERDICT_LABEL[data.verdict]);
      verdict.style.setProperty('--c', `var(${verdictToken(data.verdict)})`);
      const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
      replaceChildren(
        root,
        verdict,
        h('div', { class: 'f', 'data-testid': 'tip-file' }, data.file),
        h('div', { class: 'p', 'data-testid': 'tip-package' }, data.pkg),
        h(
          'div',
          { class: 'row', 'data-testid': 'tip-counts' },
          countLine(data.counts).map(({ status, count, text }) =>
            h('span', { class: status }, h('b', null, status === 'add' ? `+${String(count)}` : String(count)), ` ${text}`),
          ),
        ),
        h(
          'div',
          { class: 'pins' },
          data.floor === null ? null : h('span', { 'data-testid': 'tip-floor' }, `floor: ${data.floor}`),
          data.findings === 0 ? null : h('span', { class: 'n', 'data-testid': 'tip-findings' }, plural(data.findings, 'finding')),
        ),
        data.violations === 0 ? null : h('div', { class: 'pins violations', 'data-testid': 'tip-violations' }, plural(data.violations, 'rule violation')),
      );
      const width = root.offsetWidth || 250;
      const height = root.offsetHeight || 120;
      root.style.left = `${String(Math.max(8, Math.min(x + 14, container.clientWidth - width - 8)))}px`;
      root.style.top = `${String(Math.max(8, Math.min(y + 14, container.clientHeight - height - 8)))}px`;
      root.classList.add('show');
    },
    hide() {
      root.classList.remove('show');
    },
  };
}
