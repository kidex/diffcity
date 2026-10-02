// The plugins every daemon runs, in order. Setup and start follow this order,
// stop runs in reverse, so a plugin listed later may use one listed earlier.
// dbPlugin comes first so the shared database closes after every other plugin;
// the watch plugin follows the collection, whose collector and hooks it uses.

import { apiPlugin } from './api/plugin.js';
import { createCollection } from './collector/plugin.js';
import { dbPlugin } from './db.js';
import type { DaemonPlugin } from './plugin.js';
import { createWatch } from './watcher/plugin.js';

/**
 * The collection (DC-29): runs the collector on the shared database and serves
 * `track` and `register`. Plugins listed after it reach the collector through
 * `collection.collector()`.
 */
export const collection = createCollection();

/** The watchers of the active repos and the scheduler (DC-33), on top of the collection. */
export const watch = createWatch(collection);

export const daemonPlugins: readonly DaemonPlugin[] = [dbPlugin, collection.plugin, watch.plugin, apiPlugin];
