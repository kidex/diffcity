// ui/router-routes (ADR-022): #/, #/repo/:id, #/change/:id; anything else is Fleet.

import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, searchResultRoute, startRouter, type Route } from '../../../src/ui/app/router.js';

describe('ui/router-routes', () => {
  it.each<[string, Route]>([
    ['', { name: 'fleet' }],
    ['#', { name: 'fleet' }],
    ['#/', { name: 'fleet' }],
    ['#/repo/3', { name: 'repo', id: 3 }],
    ['#/repo/3/', { name: 'repo', id: 3 }],
    ['#/change/42', { name: 'change', id: 42 }],
  ])('parses %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it.each(['#/nowhere', '#/repo', '#/repo/', '#/repo/0', '#/repo/-1', '#/repo/abc', '#/repo/1.5', '#/repo/01', '#/change/7/files', 'repo/3', '#//repo/3'])(
    'sends the unknown route %j to Fleet',
    (hash) => {
      expect(parseRoute(hash)).toEqual({ name: 'fleet' });
    },
  );

  it.each<[Route, string]>([
    [{ name: 'fleet' }, '#/'],
    [{ name: 'repo', id: 3 }, '#/repo/3'],
    [{ name: 'change', id: 42 }, '#/change/42'],
  ])('writes %j as %s, which parses back to the same route', (route, href) => {
    expect(routeHref(route)).toBe(href);
    expect(parseRoute(href)).toEqual(route);
  });

  it('opens a repo result in Repo and a change or file result in its Change', () => {
    expect(searchResultRoute({ kind: 'repo', label: 'sample-shop', detail: '', repoId: 1 })).toEqual({ name: 'repo', id: 1 });
    expect(searchResultRoute({ kind: 'change', label: 'feature/order-discounts', detail: '', repoId: 1, changeId: 11 })).toEqual({
      name: 'change',
      id: 11,
    });
    expect(
      searchResultRoute({ kind: 'file', label: 'discounts.ts', detail: '', repoId: 1, changeId: 11, path: 'src/orders/discounts.ts' }),
    ).toEqual({ name: 'change', id: 11 });
  });

  describe('startRouter', () => {
    function fakeWindow(hash: string) {
      const listeners = new Set<() => void>();
      const replaced: string[] = [];
      const win = {
        location: { hash },
        history: {
          state: null,
          replaceState(_state: unknown, _title: string, url: string) {
            replaced.push(url);
            win.location.hash = url;
          },
        },
        addEventListener(_type: string, listener: () => void) {
          listeners.add(listener);
        },
        removeEventListener(_type: string, listener: () => void) {
          listeners.delete(listener);
        },
      };
      const go = (next: string): void => {
        win.location.hash = next;
        for (const listener of listeners) listener();
      };
      return { win: win as unknown as Window, replaced, go, listeners };
    }

    it('reports the current route, then every hash change', () => {
      const { win, go } = fakeWindow('#/repo/2');
      const seen: Route[] = [];
      startRouter((route) => seen.push(route), win);
      go('#/change/9');
      go('#/');
      expect(seen).toEqual([{ name: 'repo', id: 2 }, { name: 'change', id: 9 }, { name: 'fleet' }]);
    });

    it('replaces an unknown hash with #/ in place', () => {
      const { win, replaced } = fakeWindow('#/settings');
      const seen: Route[] = [];
      startRouter((route) => seen.push(route), win);
      expect(seen).toEqual([{ name: 'fleet' }]);
      expect(replaced).toEqual(['#/']);
      expect(win.location.hash).toBe('#/');
    });

    it('leaves a canonical hash alone and stops listening when disposed', () => {
      const { win, replaced, listeners } = fakeWindow('#/change/5');
      const stop = startRouter(() => undefined, win);
      expect(replaced).toEqual([]);
      stop();
      expect(listeners.size).toBe(0);
    });
  });
});
