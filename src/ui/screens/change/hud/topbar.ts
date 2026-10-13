// The change screen's top bar (mockup .top, minus the brand and search that
// the SPA shell owns): counters of files and symbols by status, the "need
// your eyes" badge, the rule-check chips, change-level findings, the Export
// PlantUML button, which arrives in a later version, with an ApprovalPort,
// Approve (hud/approve.ts), and with an AgentPort the agent run status
// (hud/agent-run.ts) and "Send to agent".
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

/** Nodes the ports add to the bar: with a ReviewPort the progress and the summary button, with an ApprovalPort Approve. */
export interface BarExtras {
  progress?: HTMLElement | undefined;
  /** With an AgentPort: the agent run status (ADR-029). */
  agent?: HTMLElement | undefined;
  summary?: HTMLElement | undefined;
  /** With an AgentPort too: "Send to agent", opening the send dialog directly (DC-136). */
  send?: HTMLElement | undefined;
  approve?: HTMLElement | undefined;
}

export function renderTopBar(bar: HTMLElement, report: Report, withCrumb: boolean, extras: BarExtras = {}): void {
  const counters = topBar(report);
  const eyes = counters.eyes;
  const level = changeLevel(report);
  const checks = checkChips(report);
  // The persistent nodes (Approve, the summary button) are moved back in: a focus inside them is kept.
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && bar.contains(active) ? active : null;
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
    extras.progress,
    extras.agent,
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
      extras.summary,
      extras.send,
      disabledButton('Export PlantUML', false, 'export-plantuml'),
      extras.approve,
    ),
  );
  if (focused !== null && bar.contains(focused)) focused.focus({ preventScroll: true });
}
