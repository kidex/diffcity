// The JSON API as a daemon plugin: opens the shared database in setup, so a
// database that cannot be opened stops the daemon from starting, and registers
// the routes before the server listens.

import { getDb } from '../db.js';
import type { DaemonPlugin } from '../plugin.js';
import { registerApiRoutes } from './routes.js';

export const apiPlugin: DaemonPlugin = {
  name: 'api',
  async setup(context, http) {
    const db = await getDb(context);
    registerApiRoutes(http, { db, now: () => new Date().toISOString() });
  },
};
