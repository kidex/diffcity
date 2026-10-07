// `#/change/:id` in the SPA: fetches the change and its latest Report from
// the daemon and hands the Report to the change screen, which never touches
// the daemon itself (ADR-002, ADR-022). The header (kind, ref, title and the
// way back to the repo) comes from the change summary; everything below it
// from the Report. SSE `snapshot` and `changes` for this change refetch both;
// the screen is mounted once and gets each new Report through update(), so
// the city keeps its camera and selection. The screen (and three.js with it)
// is loaded with import() the first time a change is opened.

import './change-route.css';

import type { ChangeSummary } from '../../core/model/types.js';
import type { Report } from '../../core/report/types.js';
import { ApiRequestError } from '../data/api.js';
import type { DataContext } from '../data/context.js';
import { createDiffPort } from '../data/diff-port.js';
import { createFindingsPort } from '../data/findings-port.js';
import { createReviewPort } from '../data/review-port.js';
import type * as ChangeScreenChunk from '../screens/change/index.js';
import type { ChangeScreen } from '../screens/change/index.js';
import type { DiffPort, FindingsPort, ReviewPort } from '../screens/change/ports.js';
import { h, replaceChildren } from '../shared/dom.js';
import {
  aheadBehind,
  ARCHIVE_REASON_LABEL,
  HEAD_NOT_FETCHED,
  HEAD_NOT_FETCHED_TITLE,
  kindLabel,
  refName,
  REVIEW_STATE_LABEL,
  shortDate,
} from '../shared/format.js';
import { routeHref } from './router.js';

type ChangeScreenModule = typeof ChangeScreenChunk;
let screenModule: Promise<ChangeScreenModule> | null = null;
/** The change screen chunk, fetched once. */
function loadChangeScreen(): Promise<ChangeScreenModule> {
  screenModule ??= import('../screens/change/index.js');
  return screenModule;
}

type Loaded = { change: ChangeSummary; report: Report | null } | { error: 'missing' | 'unreachable' };

function header(change: ChangeSummary): HTMLElement {
  const meta: (HTMLElement | string)[] = [];
  if (change.kind !== 'pr') meta.push(h('code', { 'data-testid': 'change-ref' }, refName(change)));
  meta.push(h('span', { class: 'vs' }, 'against'), h('code', null, change.base));
  const counts = aheadBehind(change);
  if (counts) meta.push(h('span', null, counts));
  if (change.dirty) meta.push(h('span', { class: 'tag mod' }, 'uncommitted changes'));
  if (change.archiveReason !== null && change.archivedAt !== null) {
    meta.push(h('span', { class: 'tag' }, `${ARCHIVE_REASON_LABEL[change.archiveReason]} ${shortDate(change.archivedAt)}`));
  } else {
    meta.push(h('span', { class: `tag review ${change.reviewState}` }, REVIEW_STATE_LABEL[change.reviewState]));
  }
  return h(
    'div',
    { class: 'title change-head', 'data-testid': 'change-head' },
    h('a', { class: 'back', href: routeHref({ name: 'repo', id: change.repoId }), 'data-testid': 'back-to-repo' }, '← All changes in this repo'),
    h('div', { class: 'name-line' }, h('span', { class: 'tag kind', 'data-testid': 'change-kind' }, kindLabel(change)), ' ', h('h1', null, change.title)),
    h('p', { class: 'meta' }, meta.flatMap((part, index) => (index === 0 ? [part] : [' ', part]))),
  );
}

export function mountChangeRoute(element: HTMLElement, context: DataContext, changeId: number): () => void {
  const { api, live, refetch } = context;
  const stage = h('section', { class: 'stage change', 'data-screen': 'change' });
  const body = h('div', { class: 'change-body' });
  replaceChildren(element, stage);
  // Not inside .title: the stage hides `.title p` at 980 px and below.
  replaceChildren(stage, h('div', { class: 'change-message' }, h('p', { role: 'status', 'data-testid': 'change-loading' }, 'Loading the change…')));

  // The ports of this change: the full diff of a file, and the review marks (ADR-028), which also hear SSE `review`.
  const diffs: DiffPort = createDiffPort(api, changeId);
  const review: ReviewPort = createReviewPort(api, live, changeId);
  // The finding actions (ADR-036): an accepted write refetches the Report at once, without waiting for SSE `findings`.
  const findings: FindingsPort = createFindingsPort(api, changeId, () => {
    reload();
  });
  let disposed = false;
  let controller: AbortController | null = null;
  let screen: ChangeScreen | null = null;
  /** The Report to mount once the screen chunk arrives; undefined when nothing waits. */
  let waiting: { report: Report | null } | undefined;
  let head: HTMLElement | null = null;
  let repoId: number | null = null;

  function unmountScreen(): void {
    screen?.unmount();
    screen = null;
    waiting = undefined;
  }

  function showReport(report: Report | null, startedAt: number): void {
    if (screen !== null) {
      screen.update(report, { startedAt });
      return;
    }
    const mountNow = waiting === undefined;
    waiting = { report };
    if (!mountNow) return;
    void loadChangeScreen().then(
      (module) => {
        if (disposed || waiting === undefined) return;
        const { report: latest } = waiting;
        waiting = undefined;
        screen = module.mountChange(body, { report: latest, diffs, review, findings });
      },
      () => {
        if (disposed || waiting === undefined) return;
        waiting = undefined;
        replaceChildren(body, h('p', { class: 'change-empty', role: 'status', 'data-testid': 'change-screen-failed' }, 'The change view could not be loaded. Reload the page to try again.'));
      },
    );
  }

  function show(loaded: Loaded, startedAt: number): void {
    if ('error' in loaded) {
      unmountScreen();
      head = null;
      stage.dataset['state'] = loaded.error;
      replaceChildren(
        stage,
        h(
          'div',
          { class: 'change-message', 'data-testid': `change-${loaded.error}` },
          h('h1', null, loaded.error === 'missing' ? 'This change is gone' : 'Can’t reach the diffcity daemon'),
          h('p', { role: 'status' }, loaded.error === 'missing' ? 'It may have been archived more than 90 days ago.' : 'The change appears as soon as the daemon answers.'),
        ),
      );
      return;
    }
    stage.dataset['state'] = 'ready';
    repoId = loaded.change.repoId;
    const nextHead = header(loaded.change);
    if (head !== null && head.parentElement === stage && body.parentElement === stage) head.replaceWith(nextHead);
    else replaceChildren(stage, nextHead, body);
    head = nextHead;
    if (loaded.report === null && !loaded.change.headAvailable) {
      // No snapshot can exist until the user fetches the head (ADR-019), so
      // this is not "computing": say why there is nothing to show.
      unmountScreen();
      replaceChildren(
        body,
        h('p', { class: 'change-empty not-fetched', 'data-testid': 'head-not-fetched', title: HEAD_NOT_FETCHED_TITLE }, HEAD_NOT_FETCHED),
      );
      return;
    }
    showReport(loaded.report, startedAt);
  }

  async function load(): Promise<void> {
    if (disposed) return;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const { signal } = current;
    // A Report fetched from here on is newer than any finding write answered before (the finding actions settle on it).
    const startedAt = performance.now();
    let loaded: Loaded;
    try {
      const [change, report] = await Promise.all([api.change(changeId, signal), api.report(changeId, signal)]);
      loaded = { change, report };
    } catch (error) {
      if (signal.aborted) return;
      // Keep a change already on screen; the daemon indicator says why it is stale.
      if (repoId !== null) return;
      loaded = { error: error instanceof ApiRequestError && error.status === 404 ? 'missing' : 'unreachable' };
    }
    if (signal.aborted) return;
    show(loaded, startedAt);
  }

  const reload = (): void => {
    if (!disposed) refetch.request(`change:${String(changeId)}`, () => void load());
  };
  const stops = [
    live.on('hello', reload),
    live.on('snapshot', (data) => {
      if (data.changeId === changeId) reload();
    }),
    // A finding's state, an import or a queued fix: the served Report moved (ADR-036).
    live.on('findings', (data) => {
      if (data.changeId === changeId) reload();
    }),
    live.on('changes', (data) => {
      if (data.repoId === repoId) reload();
    }),
  ];
  reload();

  return () => {
    disposed = true;
    for (const stop of stops) stop();
    controller?.abort();
    unmountScreen();
    element.replaceChildren();
  };
}
