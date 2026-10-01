// The plugins every daemon runs, in order. Setup and start follow this order,
// stop runs in reverse, so a plugin listed later may use one listed earlier.

import type { DaemonPlugin } from './plugin.js';

export const daemonPlugins: readonly DaemonPlugin[] = [];
