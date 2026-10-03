// The filter rows (mockup .verdicts and .types, plus the Rules row of
// ADR-026): verdicts with counters, change types with counters and "Show
// everything", and one chip per rule when the Report has rule findings. The
// rules of combining them live in model/view.ts; this only draws the chips and
// reports clicks.

import type { Report } from '../../../../core/report/types.js';
import { h, renderList } from '../../../shared/dom.js';
import { VERDICT_LABEL } from '../../../shared/format.js';
import { verdictToken } from '../../../shared/tokens.js';
import { ruleChips, typeChips, verdictChips } from '../model/hud.js';
import type { Filters } from '../model/view.js';
import { clearFilters, toggleRule, toggleType, toggleVerdict } from '../model/view.js';

/** The mockup's type labels. */
const TYPE_LABEL = { add: 'Added', mod: 'Modified', sig: 'Signature changed', del: 'Removed' } as const;

interface Chip {
  key: string;
  testId: string;
  /** The rule id, for a Rules chip. */
  rule?: string;
  label: string;
  count: number | null;
  /** CSS custom property of the swatch colour. */
  token: string | null;
  className: string;
  on: boolean;
  click(): void;
}

export interface FilterRows {
  root: HTMLElement;
  update(report: Report, filters: Filters): void;
}

/** Brings a chip button in line with `chip`; the content is rebuilt only when it changed, so focus and hover are undisturbed. */
function fill(button: HTMLButtonElement, chip: Chip): void {
  button.className = `chip ${chip.className}${chip.on ? ' on' : ''}`;
  button.setAttribute('aria-pressed', String(chip.on));
  button.dataset['testid'] = chip.testId;
  if (chip.rule !== undefined) button.dataset['rule'] = chip.rule;
  // The latest closure: the filters it toggles are the current ones.
  button.onclick = () => {
    chip.click();
  };
  const signature = `${chip.label}|${String(chip.count)}|${chip.token ?? ''}`;
  if (button.dataset['sig'] === signature) return;
  button.dataset['sig'] = signature;
  const swatch = h('i', { 'aria-hidden': 'true' });
  if (chip.token !== null) swatch.style.setProperty('--c', `var(${chip.token})`);
  button.replaceChildren(chip.token === null ? '' : swatch, chip.label, chip.count === null ? '' : h('b', null, String(chip.count)));
}

function create(chip: Chip): HTMLButtonElement {
  const button = h('button', { type: 'button' });
  fill(button, chip);
  return button;
}

function draw(row: HTMLElement, chips: Chip[]): void {
  renderList<Chip, HTMLButtonElement>(row, chips, (chip) => chip.key, create, fill);
}

export function createFilterRows(onFilters: (filters: Filters) => void): FilterRows {
  let current: Filters = clearFilters();
  const set = (next: Filters): void => {
    current = next;
    onFilters(next);
  };

  const verdictRow = h('div', { class: 'chips verdicts', role: 'group', 'aria-label': 'Filter by verdict', 'data-testid': 'filter-verdicts' });
  const typeRow = h('div', { class: 'chips types', role: 'group', 'aria-label': 'Filter by change type', 'data-testid': 'filter-types' });
  // The label sits beside the keyed chips, so they get their own container.
  const ruleList = h('div', { class: 'rule-list' });
  const ruleRow = h('div', { class: 'chips rules', role: 'group', 'aria-label': 'Filter by rule', 'data-testid': 'filter-rules' }, h('span', { class: 'row-label' }, 'Rules'), ruleList);
  ruleRow.hidden = true;
  const root = h('div', { class: 'hud-filters' }, verdictRow, typeRow, ruleRow);

  return {
    root,
    update(report, filters) {
      current = filters;
      draw(
        verdictRow,
        verdictChips(report).map(({ key, count }) => ({
          key: `v-${key}`,
          testId: `filter-verdict-${key}`,
          label: VERDICT_LABEL[key],
          count,
          token: verdictToken(key),
          className: 'verdict',
          on: current.verdict === key,
          click: () => {
            set(toggleVerdict(current, key));
          },
        })),
      );
      const types: Chip[] = typeChips(report).map(({ key, count }) => ({
        key: `t-${key}`,
        testId: `filter-type-${key}`,
        label: TYPE_LABEL[key],
        count,
        token: `--${key}`,
        className: `type ${key}`,
        on: current.type === key,
        click: () => {
          set(toggleType(current, key));
        },
      }));
      types.push({
        key: 't-clear',
        testId: 'filter-clear',
        label: 'Show everything',
        count: null,
        token: null,
        className: 'clear',
        on: false,
        click: () => {
          set(clearFilters());
        },
      });
      draw(typeRow, types);
      const rules = ruleChips(report);
      ruleRow.hidden = rules.length === 0;
      draw(ruleList, [
        ...rules.map(({ key, count }) => ({
          key: `r-${key}`,
          testId: 'filter-rule',
          rule: key,
          label: key,
          count,
          token: null,
          className: 'rule',
          on: current.rule === key,
          click: () => {
            set(toggleRule(current, key));
          },
        })),
      ]);
    },
  };
}
