// The review progress in the top bar (SPEC.md section 6): "N of M files that
// need your eyes checked", the touched files checked and the "Needs rewrite"
// marks, and, once everything that needs eyes is checked, "Everything that
// needs your eyes is checked". The numbers are the daemon's (ADR-028).

import { h, replaceChildren } from '../../../shared/dom.js';
import type { ProgressView } from '../model/review.js';

export function renderProgress(root: HTMLElement, view: ProgressView): void {
  const { attention } = view;
  const fill = h('i');
  fill.style.width = `${attention.total === 0 ? '0' : String(Math.round((attention.done / attention.total) * 100))}%`;
  root.classList.toggle('done', view.done);
  replaceChildren(
    root,
    h('strong', { class: 'rv-headline', 'data-testid': 'progress-attention' }, view.headline),
    h(
      'span',
      {
        class: 'rv-bar-track',
        role: 'progressbar',
        'aria-label': 'Files that need your eyes, checked',
        'aria-valuemin': 0,
        'aria-valuemax': attention.total,
        'aria-valuenow': attention.done,
        'data-testid': 'progress-bar',
      },
      fill,
    ),
    h('small', { 'data-testid': 'progress-touched' }, view.touched),
    h('small', { 'data-testid': 'progress-rewrite' }, view.rewrite),
    view.outdated === null ? null : h('small', { class: 'rv-stale', 'data-testid': 'progress-outdated' }, view.outdated),
  );
}
