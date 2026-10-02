// The change screen without WebGL: says why there is no city and lists the
// touched files of the Report with their status and verdict, exactly as the
// daemon computed them (the DC-34 table).

import type { Report } from '../../../core/report/types.js';
import { h } from '../../shared/dom.js';
import { STATUS_LABEL, VERDICT_LABEL } from '../../shared/format.js';

export const NO_WEBGL = '3D view needs WebGL';

function fileTable(report: Report): HTMLElement {
  // Touched = any status but `same` (SPEC.md section 5.1); the order is the Report's.
  const touched = report.packages.flatMap((pkg) => pkg.files.filter((file) => file.status !== 'same').map((file) => ({ pkg, file })));
  if (touched.length === 0) return h('p', { class: 'change-empty', 'data-testid': 'no-touched-files' }, 'This change touches no file.');
  return h(
    'table',
    { class: 'touched-files', 'data-testid': 'touched-files' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'File'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Verdict'))),
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

/** The no-WebGL view of `report`. */
export function fallbackView(report: Report): HTMLElement {
  return h(
    'section',
    { class: 'change-report', 'aria-label': 'Touched files', 'data-testid': 'no-webgl' },
    h('p', { class: 'phase-note', role: 'status', 'data-testid': 'no-webgl-note' }, NO_WEBGL),
    fileTable(report),
  );
}
