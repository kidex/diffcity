// The JSON API as a daemon plugin: opens the shared database in setup, so a
// database that cannot be opened stops the daemon from starting, and registers
// the routes before the server listens.

import { openRepo } from '../activation.js';
import { getDb } from '../db.js';
import type { DaemonPlugin } from '../plugin.js';
import { getRuntime } from '../runtime.js';
import { registerApiRoutes } from './routes.js';

export interface ApiPluginOptions {
  /** The clock of review writes (tests drive the 10-minute event gap with it). */
  now?: () => Date;
}

export function createApiPlugin(options: ApiPluginOptions = {}): DaemonPlugin {
  return {
    name: 'api',
    async setup(context, http) {
      const db = await getDb(context);
      registerApiRoutes(http, {
        db,
        port: () => context.port(),
        // `collecting` from the collector, `watch` from the watchers (src/daemon/runtime.ts).
        runtime: getRuntime(context),
        // Through the collection plugin's handler (src/daemon/activation.ts), on its clock.
        open: (repoId) => {
          openRepo(context, repoId);
        },
        broadcast: (event) => {
          context.broadcast(event);
        },
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    },
  };
}

export const apiPlugin: DaemonPlugin = createApiPlugin();
