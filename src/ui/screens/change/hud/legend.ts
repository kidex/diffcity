// The legend (mockup .legend): the four verdicts, the floor statuses and
// untouched; plus the X marker of a rule finding when the Report has any.

import { h } from '../../../shared/dom.js';
import { VERDICT_LABEL } from '../../../shared/format.js';
import { verdictToken } from '../../../shared/tokens.js';

function swatch(className: string, token: string): HTMLElement {
  const element = h('i', { class: className, 'aria-hidden': 'true' });
  element.style.setProperty('--c', `var(${token})`);
  return element;
}

const item = (className: string, token: string, text: string): HTMLElement => h('span', null, swatch(className, token), text);

export function createLegend(): { root: HTMLElement; update(hasRuleFindings: boolean): void } {
  const marker = h('span', { class: 'rule-x', 'data-testid': 'legend-rule-x' }, h('i', { class: 'x', 'aria-hidden': 'true' }, '×'), 'rule violation');
  marker.hidden = true;
  const root = h(
    'div',
    { class: 'legend', role: 'group', 'aria-label': 'Legend', 'data-testid': 'legend' },
    h(
      'span',
      { class: 'g' },
      item('dot', verdictToken('eyes'), VERDICT_LABEL.eyes.toLowerCase()),
      item('dot', verdictToken('risky'), VERDICT_LABEL.risky.toLowerCase()),
      item('dot', verdictToken('spec'), VERDICT_LABEL.spec.toLowerCase()),
      item('dot', verdictToken('ok'), VERDICT_LABEL.ok.toLowerCase()),
    ),
    item('', '--add', 'added'),
    item('', '--mod', 'modified'),
    item('', '--sig', 'signature'),
    item('del', '--del', 'removed'),
    item('', '--same-top', 'untouched'),
    marker,
  );
  return {
    root,
    update(hasRuleFindings) {
      marker.hidden = !hasRuleFindings;
    },
  };
}
