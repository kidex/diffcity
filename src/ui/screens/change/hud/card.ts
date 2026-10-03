// The selection card at the bottom right (design/directions/shared/hud.ts):
// verdict, tier, file, counts by status, and the file's symbols with their
// status. Text goes in through textContent (paths and symbol names come from
// the repo under review).

import type { Status } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import { STATUS_LABEL, VERDICT_LABEL } from '../../../shared/format.js';
import { verdictToken } from '../../../shared/tokens.js';
import type { CardData } from '../model/hud.js';
import { countLine } from '../model/hud.js';

export interface SelectionCard {
  root: HTMLElement;
  /** `focus` is the symbol id of the focused floor, marked in the list. */
  show(data: CardData | null, focus?: string | null): void;
}

const statusToken = (status: Status): string => (status === 'same' ? '--same-top' : `--${status}`);

export function createSelectionCard(): SelectionCard {
  const root = h('aside', { class: 'card sel-card', 'aria-label': 'Selected file', 'aria-live': 'polite', 'data-testid': 'selection-card' });
  root.hidden = true;
  return {
    root,
    show(data, focus = null) {
      if (data === null) {
        root.hidden = true;
        root.replaceChildren();
        return;
      }
      const verdict = h('div', { class: 'v', 'data-testid': 'card-verdict' }, h('i', { 'aria-hidden': 'true' }), VERDICT_LABEL[data.verdict]);
      verdict.style.setProperty('--c', `var(${verdictToken(data.verdict)})`);
      root.replaceChildren(
        h('div', { class: 'head' }, verdict, data.tier1 ? h('span', { class: 'tag tier', 'data-testid': 'card-tier' }, 'tier 1') : null),
        h('div', { class: 'f', 'data-testid': 'card-file' }, data.path),
        h(
          'div',
          { class: 'row', 'data-testid': 'card-counts' },
          countLine(data.counts).map(({ status, count, text }) =>
            h('span', { class: status }, h('b', null, status === 'add' ? `+${String(count)}` : String(count)), ` ${text}`),
          ),
        ),
        h(
          'ol',
          { class: 'floors', 'aria-label': 'Symbols', 'data-testid': 'card-symbols' },
          data.floors.map((floor) => {
            const swatch = h('i', { 'aria-hidden': 'true' });
            swatch.style.setProperty('--c', `var(${statusToken(floor.status)})`);
            return h(
              'li',
              { class: `s-${floor.status}${focus !== null && floor.symbolId === focus ? ' focus' : ''}`, 'data-status': floor.status },
              swatch,
              h('span', { class: 'sym' }, floor.name),
              h('span', { class: 'st' }, floor.status === 'same' ? '' : STATUS_LABEL[floor.status]),
            );
          }),
        ),
      );
      root.hidden = false;
    },
  };
}
