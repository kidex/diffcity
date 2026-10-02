// The top bar on every screen (SPEC.md section 6): brand, the fleet / repo /
// change breadcrumb from the route, the daemon indicator, and the Cmd+K search.

import type { ChangeSummary } from '../../core/model/types.js';
import type { DataContext } from '../data/context.js';
import type { DaemonState } from '../data/live.js';
import { h, replaceChildren } from '../shared/dom.js';
import { changeName, kindLabel, plural, relativeTime } from '../shared/format.js';
import { brandMark, searchIcon } from './icons.js';
import { mountPalette, type Palette } from './palette.js';
import { routeHref, type Route } from './router.js';

export interface Shell {
  setRoute(route: Route): void;
  readonly palette: Palette;
  dispose(): void;
}

const DAEMON_LABEL: Record<DaemonState, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

const DAEMON_TITLE: Record<DaemonState, string> = {
  connected: 'Live updates from the diffcity daemon',
  reconnecting: 'Lost the diffcity daemon, reconnecting',
  offline: 'The diffcity daemon is not reachable. Start it with: diffcity start',
};

/** What the breadcrumb needs, fetched for the current route. */
interface CrumbData {
  repoName?: string;
  change?: ChangeSummary;
}

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function mountShell(top: HTMLElement, context: DataContext, go: (route: Route) => void): Shell {
  const { api, live, refetch } = context;
  const palette = mountPalette(api, go);

  const crumb = h('ol', { class: 'crumb' });
  const daemonLabel = h('span', { class: 'label' });
  const daemon = h('span', { class: 'daemon', role: 'status', 'data-testid': 'daemon' }, h('i'), daemonLabel);
  const searchButton = h(
    'button',
    {
      type: 'button',
      class: 'btn search-btn',
      // The visible label is hidden at 980 px and below; the name stays.
      'aria-label': 'Search',
      'aria-keyshortcuts': 'Meta+K Control+K',
      onclick: () => {
        palette.open();
      },
    },
    searchIcon(),
    h('span', { class: 'label' }, 'Search'),
    h('span', { class: 'k' }, isMac() ? '⌘K' : 'Ctrl K'),
  );

  replaceChildren(
    top,
    h('a', { class: 'brand', href: '#/', 'aria-label': 'diffcity, all repos' }, brandMark(), 'diffcity'),
    h('nav', { 'aria-label': 'Breadcrumb' }, crumb),
    h('div', { class: 'end' }, searchButton, daemon),
  );

  const stopState = live.onState((state) => {
    daemon.dataset['state'] = state;
    daemon.title = DAEMON_TITLE[state];
    daemonLabel.textContent = DAEMON_LABEL[state];
  });

  let route: Route = { name: 'fleet' };
  let data: CrumbData = {};
  let controller: AbortController | null = null;

  function renderCrumb(): void {
    const fleet = { name: 'fleet' } as const;
    if (route.name === 'fleet') {
      replaceChildren(crumb, h('li', { 'aria-current': 'page' }, h('strong', null, 'Fleet')));
      return;
    }
    const items: HTMLLIElement[] = [h('li', null, h('a', { href: routeHref(fleet) }, 'Fleet'))];
    const repoId = route.name === 'repo' ? route.id : data.change?.repoId;
    const repoName = data.repoName ?? '…';
    if (route.name === 'repo') {
      items.push(h('li', { 'aria-current': 'page' }, h('strong', { title: repoName }, repoName)));
    } else {
      items.push(
        h('li', null, repoId === undefined ? h('span', { title: repoName }, repoName) : h('a', { href: routeHref({ name: 'repo', id: repoId }), title: repoName }, repoName)),
      );
      items.push(h('li', { 'aria-current': 'page' }, ...changeCrumb(data.change)));
    }
    replaceChildren(crumb, items);
  }

  async function load(): Promise<void> {
    controller?.abort();
    if (route.name === 'fleet') return;
    const current = new AbortController();
    controller = current;
    const { signal } = current;
    try {
      if (route.name === 'repo') {
        const detail = await api.repo(route.id, signal);
        data = { repoName: detail.repo.name };
      } else {
        const change = await api.change(route.id, signal);
        data = { ...data, change };
        renderCrumb();
        const detail = await api.repo(change.repoId, signal);
        data = { repoName: detail.repo.name, change };
      }
    } catch {
      if (signal.aborted) return;
      // Keep the last labels; the daemon indicator already tells why.
    }
    if (!signal.aborted) renderCrumb();
  }

  function reload(): void {
    refetch.request('shell:crumb', () => void load());
  }

  const stops = [
    stopState,
    live.on('hello', reload),
    live.on('repo', ({ repoId }) => {
      if (crumbRepoId() === repoId) reload();
    }),
    live.on('snapshot', ({ changeId }) => {
      if (route.name === 'change' && route.id === changeId) reload();
    }),
    live.on('changes', ({ repoId }) => {
      if (route.name === 'change' && crumbRepoId() === repoId) reload();
    }),
  ];

  function crumbRepoId(): number | undefined {
    return route.name === 'repo' ? route.id : data.change?.repoId;
  }

  return {
    palette,
    setRoute(next) {
      const sameTarget = next.name === route.name && (next.name === 'fleet' || (route.name !== 'fleet' && next.id === route.id));
      route = next;
      if (!sameTarget) data = {};
      renderCrumb();
      void load();
    },
    dispose() {
      controller?.abort();
      for (const stop of stops) stop();
      palette.dispose();
    },
  };
}

/** `feature/order-discounts against main, 4 commits, 41 min ago`, as in the mockup. */
function changeCrumb(change: ChangeSummary | undefined): HTMLElement[] {
  if (!change) return [h('span', { class: 'branch' }, '…')];
  const name = change.kind === 'branch' ? changeName(change) : kindLabel(change);
  const when = relativeTime(change.lastEvent.at);
  const meta = change.ahead === null ? when : `${plural(change.ahead, 'commit')}, ${when}`;
  // A long ref is cut with an ellipsis by CSS; the text node keeps it whole
  // for the accessible name, and the title shows it whole on hover. A PR's
  // label is short, so its title carries the PR title instead.
  return [
    h('span', { class: 'branch', title: change.kind === 'branch' ? name : change.title }, name),
    h('span', { class: 'vs' }, 'against'),
    h('span', { class: 'branch', title: change.base }, change.base),
    h('span', { class: 'vs meta' }, meta),
  ];
}
