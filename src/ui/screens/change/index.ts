// The change screen (SPEC.md section 6): the city and the reading panel. It
// renders from a Report alone and never imports src/ui/data (ADR-002,
// ADR-022): the SPA passes `live`, the HTML export does not.
//
// Until phase 3 brings the city, it lists the touched files of the Report with
// their status and verdict, exactly as the daemon computed them.

import './change.css';

import type { Report } from '../../../core/report/types.js';
import { h, replaceChildren } from '../../shared/dom.js';
import { plural, shortSha, STATUS_LABEL, VERDICT_LABEL } from '../../shared/format.js';

/** Live updates for an open change; missing in the export. */
export interface ChangeLive {
  /** Calls `listener` when a new snapshot of this change exists; returns the unsubscribe function. */
  onSnapshot(listener: () => void): () => void;
}

export interface ChangeScreenOptions {
  /** Null while the first snapshot is being computed. */
  report: Report | null;
  live?: ChangeLive;
}

export const PHASE_3_NOTE = 'Change view arrives in phase 3, with the 3D city and the reading panel. Until then, here are the files this change touches.';

function fileTable(report: Report): HTMLElement {
  // Touched = any status but `same` (SPEC.md section 5.1); the order is the Report's.
  const touched = report.packages.flatMap((pkg) => pkg.files.filter((file) => file.status !== 'same').map((file) => ({ pkg, file })));
  if (touched.length === 0) return h('p', { class: 'change-empty', 'data-testid': 'no-touched-files' }, 'This change touches no file.');
  return h(
    'table',
    { class: 'touched-files', 'data-testid': 'touched-files' },
    h(
      'thead',
      null,
      h('tr', null, h('th', { scope: 'col' }, 'File'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Verdict')),
    ),
    h(
      'tbody',
      null,
      touched.map(({ pkg, file }) =>
        h(
          'tr',
          { 'data-testid': 'touched-file', 'data-path': file.path },
          h(
            'th',
            { scope: 'row' },
            h('span', { class: 'file-path' }, file.path),
            pkg.tier1 ? h('span', { class: 'tag tier1', title: 'Tier 1 zone' }, 'tier 1') : null,
          ),
          h('td', null, h('span', { class: `tag ${file.status}`, 'data-testid': 'file-status' }, STATUS_LABEL[file.status])),
          h(
            'td',
            null,
            h('span', { class: `tag verdict ${file.verdict}`, 'data-testid': 'file-verdict' }, h('i', { 'aria-hidden': 'true' }), VERDICT_LABEL[file.verdict]),
          ),
        ),
      ),
    ),
  );
}

export function mountChange(element: HTMLElement, options: ChangeScreenOptions): () => void {
  const { report } = options;
  const body: HTMLElement[] = [];
  if (report === null) {
    body.push(h('p', { class: 'change-empty', 'data-testid': 'report-computing' }, 'Computing the first snapshot of this change…'));
  } else {
    body.push(
      h(
        'p',
        { class: 'report-meta', 'data-testid': 'report-meta' },
        h('span', null, 'against ', h('code', null, report.meta.base)),
        h('span', null, 'head ', h('code', null, shortSha(report.meta.head))),
        h('span', null, plural(report.meta.commits, 'commit')),
      ),
      fileTable(report),
    );
  }
  replaceChildren(
    element,
    h(
      'section',
      { class: 'change-report', 'aria-label': 'Touched files' },
      h('p', { class: 'phase-note', 'data-testid': 'phase-note' }, PHASE_3_NOTE),
      body,
    ),
  );
  const stopLive = options.live?.onSnapshot(() => undefined);
  return () => {
    stopLive?.();
    element.replaceChildren();
  };
}
