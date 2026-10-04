// The change screen without WebGL (DC-89): says why there is no city and lists
// the touched files of the Report, grouped by package, with their status and
// verdict exactly as the daemon computed them (the DC-34 table). It is the
// review path without the city: a click or Enter on a file opens the reading
// panel's file view (index.ts mounts the panel beside it). Plain DOM; text
// goes in through textContent.

import type { Report } from '../../../core/report/types.js';
import { h } from '../../shared/dom.js';
import { STATUS_LABEL, VERDICT_LABEL } from '../../shared/format.js';

export const NO_WEBGL = '3D view needs WebGL';

export interface FallbackOptions {
  /** A file of the list was clicked, or Enter was pressed on it. */
  onOpen(fileId: string): void;
}

export interface FallbackView {
  root: HTMLElement;
  /** A new Report of the same change: the selection stays while its file does. */
  update(report: Report): void;
  /** Marks the selected file (null: none) as the city's selection would be. */
  select(fileId: string | null): void;
}

/** Touched = any status but `same` (SPEC.md section 5.1); packages and files keep the Report's order. */
function touchedPackages(report: Report): { pkg: Report['packages'][number]; files: Report['packages'][number]['files'] }[] {
  return report.packages
    .map((pkg) => ({ pkg, files: pkg.files.filter((file) => file.status !== 'same') }))
    .filter((group) => group.files.length > 0);
}

export function fallbackView(report: Report, options: FallbackOptions): FallbackView {
  let selected: string | null = null;
  const note = h('p', { class: 'phase-note', role: 'status', 'data-testid': 'no-webgl-note' }, NO_WEBGL);
  const body = h('div', { class: 'touched-scroll', 'data-testid': 'touched-scroll' });
  const root = h('section', { class: 'change-report', 'aria-label': 'Touched files', 'data-testid': 'no-webgl' }, note, body);

  function paint(): void {
    for (const row of body.querySelectorAll<HTMLElement>('tr[data-testid="touched-file"]')) {
      const on = row.dataset['file'] === selected;
      row.classList.toggle('on', on);
      const button = row.querySelector('button');
      if (on) button?.setAttribute('aria-current', 'true');
      else button?.removeAttribute('aria-current');
    }
  }

  /** What the list shows, as text: a Report that changes nothing in it leaves the buttons (and the focus on one) alone. */
  let drawn = '';

  function draw(next: Report): void {
    const groups = touchedPackages(next);
    const signature = JSON.stringify(groups.map(({ pkg, files }) => [pkg.path, pkg.tier1, files.map((file) => [file.id, file.path, file.status, file.verdict])]));
    if (signature === drawn) return;
    drawn = signature;
    const focusedFile = body.contains(document.activeElement) ? document.activeElement?.closest<HTMLElement>('tr')?.dataset['file'] : undefined;
    if (groups.length === 0) {
      body.replaceChildren(h('p', { class: 'change-empty', 'data-testid': 'no-touched-files' }, 'This change touches no file.'));
      return;
    }
    body.replaceChildren(
      h(
        'table',
        { class: 'touched-files', 'data-testid': 'touched-files' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'File'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Verdict'))),
        groups.map(({ pkg, files }) =>
          h(
            'tbody',
            { 'data-testid': 'touched-package', 'data-package': pkg.path },
            h(
              'tr',
              { class: 'pkg-row' },
              h(
                'th',
                { scope: 'rowgroup', colspan: 3 },
                h('span', { class: 'pkg-path' }, pkg.path === '' ? '(root)' : pkg.path),
                pkg.tier1 ? h('span', { class: 'tag tier', title: 'Tier 1 zone' }, 'tier 1') : null,
              ),
            ),
            files.map((file) =>
              h(
                'tr',
                { 'data-testid': 'touched-file', 'data-path': file.path, 'data-file': file.id },
                h(
                  'th',
                  { scope: 'row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'file-open',
                      'data-testid': 'touched-file-open',
                      title: 'Open the file',
                      onclick: () => {
                        options.onOpen(file.id);
                      },
                    },
                    h('span', { class: 'file-path' }, file.path),
                  ),
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
        ),
      ),
    );
    paint();
    // A redraw keeps the keyboard where it was.
    if (focusedFile !== undefined) body.querySelector<HTMLElement>(`tr[data-file="${CSS.escape(focusedFile)}"] button`)?.focus({ preventScroll: true });
  }

  draw(report);
  return {
    root,
    update(next) {
      draw(next);
    },
    select(fileId) {
      selected = fileId;
      paint();
    },
  };
}
