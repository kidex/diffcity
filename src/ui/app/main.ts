// Bootstrap of the SPA served by the daemon: styles and fonts, the shell, the
// SSE connection and the hash router (ADR-022). The theme follows
// prefers-color-scheme through tokens.css; `data-theme` on <html> overrides it.

import '../shared/tokens.css';
import '../shared/base.css';
import '../shared/components.css';
import '../shared/fonts.js';

import { createApi } from '../data/api.js';
import type { DataContext } from '../data/context.js';
import { connectLive, createCoalescer } from '../data/live.js';
import { createReviewPort } from '../data/review-port.js';
import { mountFleet } from '../screens/fleet/index.js';
import { mountRepo } from '../screens/repo/index.js';
import { mountChangeRoute } from './change-route.js';
import { navigate, startRouter, type Route } from './router.js';
import { mountShell } from './shell.js';

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`index.html has no #${id}`);
  return element;
}

const api = createApi();
const live = connectLive();
const context: DataContext = {
  api,
  live,
  refetch: createCoalescer(),
  review: (changeId) => createReviewPort(api, live, changeId),
};
const view = required('view');
const shell = mountShell(required('top'), context, (route) => {
  navigate(route);
});

let unmount: (() => void) | null = null;
let mounted: Route | null = null;

function mountScreen(route: Route): void {
  if (mounted && mounted.name === route.name && (route.name === 'fleet' || (mounted.name !== 'fleet' && mounted.id === route.id))) return;
  unmount?.();
  const previous = mounted;
  mounted = route;
  switch (route.name) {
    case 'fleet':
      unmount = mountFleet(view, context);
      break;
    case 'repo':
      // Back from a change: the Repo screen puts focus on that change's row.
      unmount = mountRepo(view, context, route.id, previous?.name === 'change' ? { fromChange: previous.id } : {});
      break;
    case 'change':
      unmount = mountChangeRoute(view, context, route.id);
      break;
  }
}

startRouter((route) => {
  shell.setRoute(route);
  mountScreen(route);
});
