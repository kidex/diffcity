// The plugins every daemon runs, in order. Setup and start follow this order,
// stop runs in reverse, so a plugin listed later may use one listed earlier.

import { createCollection } from './collector/plugin.js';
import type { DaemonPlugin } from './plugin.js';

/**
 * The collection (DC-29): opens the database, runs the collector and serves
 * `track` and `register`. Plugins listed after it read the database through
 * `collection.db()` and the collector through `collection.collector()`.
 */
export const collection = createCollection();

export const daemonPlugins: readonly DaemonPlugin[] = [collection.plugin];
