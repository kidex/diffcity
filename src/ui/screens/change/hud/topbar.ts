// The change screen's top bar (mockup .top, minus the brand and search that
// the SPA shell owns): counters of files and symbols by status, the "need
// your eyes" badge, the rule-check chips, change-level findings, and the
// Export PlantUML and Approve buttons, which arrive in a later version.
// With `crumb` the bar also carries the mockup's breadcrumb (repo, branch
// against base, commits and time) for a screen mounted without the SPA shell;
// inside the SPA the shell already shows it and `crumb` is off.

import type { Report } from '../../../../core/report/types.js';
import { h, replaceChildren } from '../../../shared/dom.js';
import { relativeTime, STATUS_LABEL } from '../../../shared/format.js';
import { changeLevel, changeLevelText, checkChips, commitsText, topBar } from '../model/hud.js';

export const LATER_VERSION = 'Arrives in a later version';

function stat(id: string, value: number, label: string, status?: string): HTMLElement {
  return h(
    'div',
    { class: 'stat', 'data-testid': `stat-${id}` },
    status === undefined ? null : h('span', { class: `sw ${status}`, 'aria-hidden': 'true' }),
    h('b', null, String(value)),
    h('small', null, label),
  );
}

function crumb(report: Report): HTMLElement {
  const { meta } = report;
  return h(
    'div',
    { class: 'crumb', 'data-testid': 'hud-crumb' },
    h('strong', null, meta.repo),
    h('span', { class: 'branch', title: meta.head }, meta.head),
    h('span', { class: 'vs' }, 'against'),
    h('span', { class: 'branch', title: meta.base }, meta.base),
    h('span', { class: 'vs' }, `${commitsText(meta.commits)}, ${relativeTime(meta.generatedAt)}`),
  );
}

function disabledButton(label: string, primary: boolean, testId: string): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: primary ? 'btn primary' : 'btn',
      'aria-disabled': 'true',
      title: LATER_VERSION,
      'data-testid': testId,
      // Focusable so the reason is reachable by keyboard; it does nothing.
      onclick: (event: Event) => {
        event.preventDefault();
      },
    },
    label,
  );
}

export function renderTopBar(bar: HTMLElement, report: Report, withCrumb: boolean): void {
  const counters = topBar(report);
  const eyes = counters.eyes;
  const level = changeLevel(report);
  const checks = checkChips(report);
  replaceChildren(
    bar,
    withCrumb ? crumb(report) : null,
    h(
      'div',
      { class: 'stats', 'data-testid': 'stats' },
      stat('files', counters.files, counters.files === 1 ? 'file' : 'files'),
      counters.statuses.map(({ key, count }) => stat(key, count, STATUS_LABEL[key], key)),
    ),
    h(
      'div',
      { class: eyes > 0 ? 'tier' : 'tier quiet', 'data-testid': 'eyes-badge' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      eyes === 0 ? 'No files need your eyes before merge' : `${String(eyes)} ${eyes === 1 ? 'file needs' : 'files need'} your eyes before merge`,
    ),
    level === null
      ? null
      : h(
          'div',
          { class: 'change-level', 'data-testid': 'change-level' },
          level.ciFailed ? h('span', { class: 'level-pill', 'data-testid': 'ci-failed' }, 'CI failed') : null,
          level.others > 0 ? h('span', { class: 'level-pill', 'data-testid': 'change-level-findings' }, changeLevelText(level.others)) : null,
        ),
    checks.length === 0
      ? null
      : h(
          'ul',
          { class: 'check-chips', 'aria-label': 'Rule checks', 'data-testid': 'check-chips' },
          checks.map((check) =>
            h(
              'li',
              {
                class: `check-chip ${check.state}`,
                'data-testid': 'check-chip',
                'data-rule': check.ruleId,
                'data-state': check.state,
                title: check.reason ?? check.text,
              },
              h('i', { 'aria-hidden': 'true' }),
              check.text,
            ),
          ),
        ),
    h(
      'div',
      { class: 'actions' },
      disabledButton('Export PlantUML', false, 'export-plantuml'),
      disabledButton('Approve when tier 1 is read', true, 'approve'),
    ),
  );
}
