// Hash router (ADR-022): the same URLs work under the daemon and from a
// file:// export. `#/` Fleet, `#/repo/:id` Repo, `#/change/:id` Change; any
// other hash is Fleet.

import type { SearchResult } from '../../core/model/types.js';

export type Route = { name: 'fleet' } | { name: 'repo'; id: number } | { name: 'change'; id: number };

const ID = '([1-9][0-9]{0,15})';
const PATTERNS: readonly [RegExp, 'repo' | 'change'][] = [
  [new RegExp(`^/repo/${ID}$`), 'repo'],
  [new RegExp(`^/change/${ID}$`), 'change'],
];

/** The route for a location hash (`#/repo/3`); unknown or malformed → Fleet. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/(.)\/$/, '$1');
  for (const [pattern, name] of PATTERNS) {
    const id = pattern.exec(path)?.[1];
    if (id !== undefined) return { name, id: Number(id) };
  }
  return { name: 'fleet' };
}

/** The canonical hash of a route. */
export function routeHref(route: Route): string {
  switch (route.name) {
    case 'fleet':
      return '#/';
    case 'repo':
      return `#/repo/${String(route.id)}`;
    case 'change':
      return `#/change/${String(route.id)}`;
  }
}

/** Where a Cmd+K result leads: a repo to Repo, a change or a touched file to its Change. */
export function searchResultRoute(result: SearchResult): Route {
  return result.kind === 'repo' ? { name: 'repo', id: result.repoId } : { name: 'change', id: result.changeId };
}

/**
 * Calls `onRoute` for the current hash and on every change. A non-canonical
 * hash (unknown route, trailing slash) is replaced in place, without a new
 * history entry. Returns the function that stops listening.
 */
export function startRouter(onRoute: (route: Route) => void, win: Window = window): () => void {
  const handle = (): void => {
    const route = parseRoute(win.location.hash);
    const canonical = routeHref(route);
    if (win.location.hash !== canonical) win.history.replaceState(win.history.state, '', canonical);
    onRoute(route);
  };
  win.addEventListener('hashchange', handle);
  handle();
  return () => {
    win.removeEventListener('hashchange', handle);
  };
}

/** Navigates to a route (a new history entry). */
export function navigate(route: Route, win: Window = window): void {
  win.location.hash = routeHref(route);
}
