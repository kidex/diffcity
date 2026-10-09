// Preloaded with `node --import` by tests that check which modules a command
// loads. Appends the URL of every module Node loads, one per line, to the file
// named by DIFFCITY_TEST_IMPORT_LOG.
//
// The hook runs in-thread through module.registerHooks (DC-130). The
// off-thread module.register() blocks the main thread in Atomics.wait until
// its hooks thread answers; when that thread never does, the process waits
// forever before running a line of the CLI (seen as orphans hours old, their
// main thread parked in Atomics.wait under this file's evaluation). register()
// stays only as the fallback for a Node without registerHooks (< 22.15).

import { appendFileSync } from 'node:fs';
import * as nodeModule from 'node:module';

const log = process.env.DIFFCITY_TEST_IMPORT_LOG;
if (log === undefined || log === '') {
  throw new Error('import-recorder: set DIFFCITY_TEST_IMPORT_LOG to the log file path');
}

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      appendFileSync(log, `${url}\n`);
      return nextLoad(url, context);
    },
  });
} else {
  nodeModule.register(new URL('./import-recorder-hooks.mjs', import.meta.url), { data: { log } });
}
