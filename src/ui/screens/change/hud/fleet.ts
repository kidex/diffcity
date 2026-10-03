// The Fleet card at the bottom right (mockup .fleet): the last audit of the
// other repos, red above 30 days or with new CVEs. It exists only with a
// FleetPort; without one nothing is drawn.

import { h, replaceChildren } from '../../../shared/dom.js';
import type { FleetCard, FleetPort } from '../ports.js';

export interface FleetCardView {
  root: HTMLElement;
  dispose(): void;
}

export function createFleetCard(port: FleetPort): FleetCardView {
  const root = h('aside', { class: 'card fleet-card', 'aria-label': 'Audit status across your projects', 'data-testid': 'fleet-card' });
  const draw = (card: FleetCard | null): void => {
    if (card === null || card.rows.length === 0) {
      root.hidden = true;
      root.replaceChildren();
      return;
    }
    root.hidden = false;
    replaceChildren(
      root,
      h(
        'h3',
        null,
        'Last full audit',
        h(
          'a',
          {
            href: '#/',
            onclick: (event: Event) => {
              event.preventDefault();
              port.open();
            },
          },
          `all ${String(card.total)} projects`,
        ),
      ),
      card.rows.map((row) => {
        const bar = h('i');
        bar.style.width = `${String(Math.round(Math.min(1, Math.max(0, row.fill)) * 100))}%`;
        return h(
          'div',
          { class: `r ${row.level}`, 'data-testid': 'fleet-row', 'data-level': row.level },
          h('span', { class: 'n' }, row.name),
          h('span', { class: 'age' }, row.age),
          h('span', { class: 'bar', 'aria-hidden': 'true' }, bar),
        );
      }),
    );
  };
  draw(port.card());
  const stop = port.onChange(() => {
    draw(port.card());
  });
  return {
    root,
    dispose: stop,
  };
}
