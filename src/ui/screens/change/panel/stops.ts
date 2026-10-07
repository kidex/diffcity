// A stop of the reading path as a card (mockup .step): rail and node, symbol,
// file, the file's verdict and the status tag, `why`, the inline diff and the
// findings with their sources. Plain DOM; every text goes in through
// textContent (symbol names, why texts, diffs and finding texts come from the
// repo under review).

import type { DiffLine, Finding, Status } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import { STATUS_LABEL, VERDICT_LABEL } from '../../../shared/format.js';
import type { Stop } from '../model/panel.js';
import { sourcesOf } from '../model/findings.js';

const GUTTER: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: ' ' };
const LINE_CLASS: Record<DiffLine['kind'], string> = { add: 'a', del: 'd', ctx: 'c' };

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The status of a stop: its symbol's, or its file's when the Report does not have the symbol. */
export const stopStatus = (stop: Stop): Status => stop.symbol?.status ?? stop.placed.file.status;

export function verdictTag(verdict: keyof typeof VERDICT_LABEL, testId?: string): HTMLElement {
  return h('span', { class: `tag verdict ${verdict}`, 'data-testid': testId }, h('i', { 'aria-hidden': 'true' }), VERDICT_LABEL[verdict]);
}

/** The inline diff: `+`, `−` and context lines, in the code block of the mockup. */
export function codeBlock(lines: readonly DiffLine[], label: string): HTMLElement {
  return h(
    'div',
    { class: 'code', role: 'group', 'aria-label': label, 'data-testid': 'step-diff' },
    lines.map((line) => h('div', { class: `l ${LINE_CLASS[line.kind]}` }, h('span', { class: 'g', 'aria-hidden': 'true' }, GUTTER[line.kind]), line.text)),
  );
}

const STATE_TEXT: Record<Finding['state'], string> = { open: 'open', intended: 'intended', fixed: 'fixed' };

/**
 * A finding with its state, every source that reported it, and the slot of its
 * action buttons ("Ask agent to fix", "Mark as intended", "Undo"): empty and
 * hidden here; the panel fills it when the screen has a FindingsPort.
 */
export function pin(finding: Finding): HTMLElement {
  const sources = sourcesOf(finding);
  return h(
    'div',
    { class: `pin ${finding.state}`, 'data-testid': 'finding', 'data-state': finding.state, 'data-severity': finding.severity, 'data-finding': finding.id },
    h('span', { class: `sev ${finding.severity}`, 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 't' }, finding.title, finding.state === 'open' ? null : h('span', { class: 'state', 'data-testid': 'finding-state' }, STATE_TEXT[finding.state])),
      h('div', { class: 'm' }, finding.message),
      h('div', { class: 'fix', 'data-testid': 'finding-actions', hidden: true }),
    ),
    h(
      'ul',
      { class: 'srcs', 'aria-label': sources.length === 1 ? 'Source' : 'Sources', 'data-testid': 'finding-sources' },
      sources.map((source) => h('li', { class: 'src', title: source, 'data-testid': 'finding-source' }, source)),
    ),
  );
}

export interface StopCardOptions {
  /** Without the inline diff: the file view shows the excerpts in its diff area. */
  compact?: boolean;
}

export interface StopCard {
  root: HTMLElement;
  stop: Stop;
}

export function stopCard(stop: Stop, options: StopCardOptions = {}): StopCard {
  const status = stopStatus(stop);
  const { file } = stop.placed;
  const name = stop.symbol?.name ?? stop.step.symbolId;
  const root = h(
    'article',
    {
      class: `step ${status}`,
      tabindex: 0,
      'aria-label': `Stop ${String(stop.order)}: ${name} in ${file.path}`,
      'data-testid': 'stop-card',
      'data-order': stop.order,
      'data-file': file.id,
      'data-symbol': stop.step.symbolId,
    },
    h('span', { class: 'rail', 'aria-hidden': 'true' }),
    h('span', { class: 'node', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'sym', 'data-testid': 'stop-symbol' }, name),
      h('span', { class: 'file', title: file.path, 'data-testid': 'stop-file' }, baseName(file.path)),
      h('span', { class: 'tags' }, verdictTag(file.verdict, 'stop-verdict'), h('span', { class: `tag ${status}`, 'data-testid': 'stop-status' }, STATUS_LABEL[status])),
    ),
    h('p', { class: 'why', 'data-testid': 'stop-why' }, stop.step.why),
    options.compact === true || stop.step.diff.length === 0 ? null : codeBlock(stop.step.diff, `Changes in ${name}`),
    stop.findings.map(pin),
  );
  return { root, stop };
}
