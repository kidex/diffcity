// The JSON API as a daemon plugin: opens the shared database in setup, so a
// database that cannot be opened stops the daemon from starting, and registers
// the routes before the server listens.

import { openRepo } from '../activation.js';
import { getDb } from '../db.js';
import type { DaemonPlugin } from '../plugin.js';
import { createDiffPool, type DiffPool, type DiffPoolOptions } from '../diff/pool.js';
import { getRuntime } from '../runtime.js';
import { registerApiRoutes } from './routes.js';

export interface ApiPluginOptions {
  /** The clock of review writes (tests drive the 10-minute event gap with it). */
  now?: () => Date;
  /** The diff pool's runner, worker script, size and job timeout; defaults to threads (ADR-027). */
  diffPool?: DiffPoolOptions;
}

export function createApiPlugin(options: ApiPluginOptions = {}): DaemonPlugin {
  let pool: DiffPool | null = null;
  return {
    name: 'api',
    async setup(context, http) {
      const db = await getDb(context);
      const diffPool = createDiffPool({
        ...options.diffPool,
        onWorkerLost: (reason) => {
          context.log.warn(`diff worker replaced: ${reason}`);
        },
      });
      pool = diffPool;
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
        diff: { pool: diffPool, log: context.log },
      });
    },
    async stop() {
      // Safe whatever setup reached: only what was created is stopped.
      const current = pool;
      pool = null;
      await current?.shutdown();
    },
  };
}

export const apiPlugin: DaemonPlugin = createApiPlugin();
