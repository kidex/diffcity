// The plugins every daemon runs, in order. Setup and start follow this order,
// stop runs in reverse, so a plugin listed later may use one listed earlier.
// dbPlugin comes first so the shared database closes after every other plugin.

import { apiPlugin } from './api/plugin.js';
import { dbPlugin } from './db.js';
import type { DaemonPlugin } from './plugin.js';

export const daemonPlugins: readonly DaemonPlugin[] = [dbPlugin, apiPlugin];
