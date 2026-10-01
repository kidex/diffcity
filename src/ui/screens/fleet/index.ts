// Fleet (SPEC.md section 6): every repo as a lot on a map, then the repo list
// with counters. Data comes from `GET /api/repos` as the daemon computed it;
// SSE `hello`, `repo` and `collect` refetch it (ADR-017), coalesced per 250 ms.

import './fleet.css';

import type { RepoSummary } from '../../../core/model/types.js';
import type { DataContext } from '../../data/context.js';
import { h, replaceChildren } from '../../shared/dom.js';
import { createFleetList } from './list.js';
import { createFleetMap } from './map.js';

/** The command the empty state teaches (SPEC.md section 3). */
export const START_COMMAND = 'diffcity start';

const REFETCH_KEY = 'fleet:repos';
/** Relative times ("3 min ago") are redrawn this often. */
const CLOCK_MS = 30_000;

type FleetState = 'loading' | 'ready' | 'empty' | 'unreachable';

function emptyState(): HTMLElement {
  const command = h('code', null, START_COMMAND);
  const copy = h('button', { type: 'button', class: 'btn copy', 'aria-label': 'Copy the command' }, 'Copy');
  copy.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(START_COMMAND)
      .then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1600);
      })
      .catch(() => undefined);
  });
  return h(
    'div',
    { class: 'fleet-empty', 'data-testid': 'fleet-empty' },
    h('div', { class: 'empty-lot', 'aria-hidden': 'true' }, h('span')),
    h('h2', null, 'No repos yet'),
    h('p', null, 'Run this inside a repo you work in. diffcity starts in the background, adds the repo and opens it here.'),
    h('div', { class: 'cmd' }, h('span', { class: 'prompt', 'aria-hidden': 'true' }, '$'), command, copy),
  );
}

function unreachable(): HTMLElement {
  return h(
    'div',
    { class: 'fleet-empty', 'data-testid': 'fleet-unreachable' },
    h('h2', null, 'Can’t reach the diffcity daemon'),
    h('p', null, 'The list appears as soon as the daemon answers. To start it, run this inside a repo:'),
    h('div', { class: 'cmd' }, h('span', { class: 'prompt', 'aria-hidden': 'true' }, '$'), h('code', null, START_COMMAND)),
  );
}

export function mountFleet(element: HTMLElement, context: DataContext): () => void {
  const { api, live, refetch } = context;
  const go = (href: string): void => {
    window.location.hash = href;
  };

  const map = createFleetMap();
  const list = createFleetList(go);
  map.onHot((id) => {
    list.setHot(id);
  });
  list.onHot((id) => {
    map.setHot(id);
  });

  const title = h(
    'div',
    { class: 'title' },
    h('h1', null, 'Your repos'),
    h('p', null, 'Every repo you work in is a lot. The bigger the lot, the more changes wait for your review.'),
  );
  const status = h('p', { class: 'fleet-status', role: 'status' });
  const stage = h('section', { class: 'stage fleet', 'data-screen': 'fleet' });
  replaceChildren(element, stage);

  let repos: RepoSummary[] | null = null;
  let failed = false;
  let controller: AbortController | null = null;
  let shown: FleetState | null = null;
  /** Set on unmount: a trailing coalesced refetch then does nothing (an answer in flight is aborted). */
  let disposed = false;

  function state(): FleetState {
    if (repos === null) return failed ? 'unreachable' : 'loading';
    return repos.length === 0 ? 'empty' : 'ready';
  }

  function render(): void {
    const next = state();
    stage.dataset['state'] = next;
    if (next !== shown) {
      shown = next;
      switch (next) {
        case 'loading':
          status.textContent = 'Loading repos…';
          replaceChildren(stage, h('div', { class: 'fleet-hero' }, title, status));
          break;
        case 'unreachable':
          replaceChildren(stage, h('div', { class: 'fleet-hero' }, title, unreachable()));
          break;
        case 'empty':
          replaceChildren(stage, h('div', { class: 'fleet-hero' }, title, emptyState()));
          break;
        case 'ready':
          replaceChildren(stage, map.element, list.element);
          map.element.prepend(title);
          break;
      }
    }
    if (next === 'ready' && repos) {
      const now = Date.now();
      map.render(repos, now);
      list.render(repos, now);
    }
  }

  async function load(): Promise<void> {
    if (disposed) return;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    try {
      const next = await api.repos(current.signal);
      if (current.signal.aborted) return;
      repos = next;
      failed = false;
    } catch {
      if (current.signal.aborted) return;
      // Keep what is on screen; the daemon indicator says why it is stale.
      failed = true;
    }
    render();
  }

  const reload = (): void => {
    if (disposed) return;
    refetch.request(REFETCH_KEY, () => void load());
  };

  const stops = [live.on('hello', reload), live.on('repo', reload), live.on('collect', reload)];
  const clock = setInterval(() => {
    if (shown === 'ready') render();
  }, CLOCK_MS);

  render();
  reload();

  return () => {
    disposed = true;
    for (const stop of stops) stop();
    clearInterval(clock);
    controller?.abort();
    map.dispose();
    element.replaceChildren();
  };
}
